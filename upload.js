export function fileFingerprint(file) { return `${file.name}\n${file.size}\n${file.lastModified}`; }

function acknowledgedOffset(response) {
    const range = response.headers.get('Range');
    return range ? Number(range.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1 : 0;
}

/** Native GCS resumable upload; byte contents go directly from browser to Google. */
export async function uploadResumable(file, session, { signal, onProgress = () => {}, fetchImpl = fetch, chunkSize = 8 * 1024 * 1024 } = {}) {
    async function probe() {
        const response = await fetchImpl(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${file.size}` }, body: '', signal });
        if (response.ok) return { complete: true, offset: file.size };
        if (response.status !== 308) { const error = new Error(`续传会话不可用（HTTP ${response.status}），请开始新上传。`); error.status = response.status; throw error; }
        return { complete: false, offset: acknowledgedOffset(response) };
    }
    let state = await probe();
    let failures = 0;
    onProgress(state.offset, file.size);
    while (!state.complete && state.offset < file.size) {
        const end = Math.min(state.offset + chunkSize, file.size);
        for (;;) {
            try {
                const response = await fetchImpl(session, {
                    method: 'PUT', body: file.slice(state.offset, end), signal,
                    headers: { 'Content-Range': `bytes ${state.offset}-${end - 1}/${file.size}` },
                });
                if (response.ok) state = { complete: true, offset: file.size };
                else if (response.status === 308) {
                    const offset = acknowledgedOffset(response);
                    if (offset <= state.offset) throw new Error('上传没有前进，请重试。');
                    state = { complete: false, offset };
                } else {
                    const error = new Error(`上传失败（HTTP ${response.status}）。`);
                    error.status = response.status;
                    throw error;
                }
                failures = 0;
                break;
            } catch (error) {
                if (signal?.aborted || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) || ++failures > 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * failures));
                // A lost response does not mean a lost chunk. Ask GCS before sending bytes again.
                state = await probe();
                break;
            }
        }
        onProgress(state.offset, file.size);
    }
    if (!state.complete) state = await probe();
    if (!state.complete) throw new Error('视频上传尚未完成，可选择相同文件继续。');
}

/** Browser sends each chunk only to the configured copyparty node; Google copying is server-side. */
export async function uploadToNode(file, session, { signal, onProgress = () => {}, fetchImpl = fetch, chunkSize = 4 * 1024 * 1024 } = {}) {
    async function probe() {
        const response=await fetchImpl(session,{signal,credentials:'omit'});
        if(!response.ok)throw new Error('上传会话已失效，请重新开始。');
        const data=await response.json();
        if(!Number.isSafeInteger(data.offset)||data.offset<0||data.offset>file.size)throw new Error('上传节点返回无效进度。');
        return data.offset;
    }
    let done=await probe(), failures=0;onProgress(done,file.size);
    while(done<file.size) {
        const end=Math.min(done+chunkSize,file.size);
        try {
            const response=await fetchImpl(session,{method:'PUT',credentials:'omit',signal,headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${done}-${end-1}/${file.size}`},body:file.slice(done,end)});
            if(!response.ok)throw new Error('分片上传失败，将查询进度后重试。');
            const data=await response.json();if(data.offset!==end)throw new Error('上传进度不一致。');
            done=end;failures=0;
        } catch(error) {
            if(signal?.aborted||++failures>3)throw error;
            await new Promise(resolve=>setTimeout(resolve,1000*failures));done=await probe();
        }
        onProgress(done,file.size);
    }
}
