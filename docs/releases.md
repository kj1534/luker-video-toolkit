# 1.0.0

The file library now runs as an independent application with its own login, user-scoped revocable tokens, durable jobs and shared configuration. The Luker connector retains uploads, imports, file selection and turn-scoped native Gemini attachments; administration moves to the independent application. Existing object prefixes, URIs, catalogs and copy indexes migrate without reuploading file data.

Workers use native copyparty up2k for both GCS readback and downloaded-file synchronization. Short-link redirects use the selected parser proxy with HTTPS/public-address validation and bounded redirects; public IPv4 is preferred for proxy compatibility. A shared task lease coordinates manual and scheduled proxy selection.

Validation: existing attachment/storage tests, CSRF/token revocation, independent UI navigation, small/large automatic upload placement and explicit dual copies; two real transfers above 100 MiB with full SHA256 verification, including one interrupted native-chunk upload with only missing chunks retransmitted; official YouTube short-link import and active-task selector exclusion. Site availability still depends on the configured node and the source site's current access policies.

Upgrade both official Luker components together and migrate each user to its original storage prefix. See [installation](installation.md) and [operations](independent-app.md).
