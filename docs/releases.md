# 1.0.1

The Luker connector now preserves the independent service's HTTP status when an error response is plain text. A denied administrator request or revoked token reports its original 403/401 status instead of an unrelated 502 parsing error. Authorization boundaries are unchanged.

Validated against the deployed connector; native mixed attachments, regeneration and streaming conversion passed all seven checks in the unmodified Luker runtime.

# 1.0.0

The file library now runs as an independent application with its own login, user-scoped revocable tokens, durable jobs and shared configuration. The Luker connector retains uploads, imports, file selection and turn-scoped native Gemini attachments; administration moves to the independent application. Existing object prefixes, URIs, catalogs and copy indexes migrate without reuploading file data.

Workers use native copyparty up2k for both GCS readback and downloaded-file synchronization. Short-link redirects use the selected parser proxy with HTTPS/public-address validation and bounded redirects; public IPv4 is preferred for proxy compatibility. A shared task lease coordinates manual and scheduled proxy selection.

Validation: existing attachment/storage tests, CSRF/token revocation, independent UI navigation, small/large automatic upload placement and explicit dual copies; two real transfers above 100 MiB with full SHA256 verification, including one interrupted native-chunk upload with only missing chunks retransmitted; official YouTube short-link import and active-task selector exclusion. Site availability still depends on the configured node and the source site's current access policies.

Upgrade both official Luker components together and migrate each user to its original storage prefix. See [installation](installation.md) and [operations](independent-app.md).
# 1.0.2

The Luker attachment menu now has one File Library entry. It opens the existing browser, upload, import, task and attachment tools; connection and direct-link attachment are available there, and an invalid old connection prompts for a new user token.

The independent app accepts explicit private owner grants for account transfers. A granted user can list and use objects under the previous owner's GCS prefix and see its unexpired direct-link catalog entries. New uploads stay under the new user's prefix; original object URIs and bytes are unchanged. Grants are configured only in the private application JSON, not exposed through the browser settings form. The old account can remain disabled with no tokens.

Validation: owner-grant authorization and pagination checks, file-library/settings tests, and production account/index verification. The independent application's visual redesign is left to the next frontend iteration.
# 1.0.3

The independent app now places the current user's login-password control in User management, while token issuance and revocation remain in Plugin tokens. User management is available to every signed-in user for their own password; only administrators see other users and account creation. The Luker connection and service API are unchanged.
