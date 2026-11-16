# CD Android transfer SDK

Preview `in.yash0.cd:transfer-android:0.1.0-preview.1`, Android API 29+, Java 17.
The supported host API is in `in.yash0.cd.sdk`. The existing CD app also uses
this module's lower-level wire/stream engine for its resume and direct-path
adapters. Those lower-level types remain preview implementation contracts.

Build and publish a local versioned repository:

```sh
android/gradlew -p android :transfer:publishReleasePublicationToPreviewRepository
```

Output: `android/transfer/build/repository/`. Add that Maven repository to a
host project and depend on the coordinate above. This does not publish to a
remote Maven service. See the [integration guide](../../docs/third-party-integration.md)
for consent, streams, cancellation, completion, limits and support policy.
`android/sample` is the independent host example.
