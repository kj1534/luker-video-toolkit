import { createHash, createSign } from 'node:crypto';
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** Short-lived GET URLs are bearer credentials; never log or persist them in chat. */
export function signDownload(credential, bucket, name, { download = false, title = 'file', mime = 'application/octet-stream', generation, now = new Date(), expires = 900 } = {}) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
    const parameters = {
        'X-Goog-Algorithm': 'GOOG4-RSA-SHA256', 'X-Goog-Credential': `${credential.client_email}/${scope}`,
        'X-Goog-Date': stamp, 'X-Goog-Expires': String(expires), 'X-Goog-SignedHeaders': 'host',
        'response-content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encode(String(title).replace(/[\r\n]/g, '_'))}`,
        'response-content-type': mime,
    };
    if (generation) parameters.generation = String(generation);
    const query = Object.entries(parameters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const pathname = '/' + [bucket, ...name.split('/')].map(encode).join('/');
    const request = `GET\n${pathname}\n${query}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`;
    const text = `GOOG4-RSA-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(request).digest('hex')}`;
    const signature = createSign('RSA-SHA256').update(text).sign(credential.private_key, 'hex');
    return { url: `https://storage.googleapis.com${pathname}?${query}&X-Goog-Signature=${signature}`, expires_at: new Date(now.getTime() + expires * 1000).toISOString() };
}
