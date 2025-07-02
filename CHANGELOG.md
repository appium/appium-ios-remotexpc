## 1.0.0 (2025-07-02)

### Features

* add prettier format to project ([a9eaee5](https://github.com/appium/appium-ios-remotexpc/commit/a9eaee520238b0c1c0ff70e4e2e3dbdcd949e611))
* print network type during interactive device selection ([53f97e7](https://github.com/appium/appium-ios-remotexpc/commit/53f97e7c4c3e7bfad6ff25f9468b0eae139620ba))

### Bug Fixes

* Added types to support tunnel creation in appium-xcuitest-driver ([#36](https://github.com/appium/appium-ios-remotexpc/issues/36)) ([d66c972](https://github.com/appium/appium-ios-remotexpc/commit/d66c9720761ef56d51a954b7105190a9a7b07bb6))
* Addressing missed pr16 review comments ([#22](https://github.com/appium/appium-ios-remotexpc/issues/22)) ([f33b725](https://github.com/appium/appium-ios-remotexpc/commit/f33b725c07482a602649636d0b8eb5d49e2c60c1))
* ensure errors are properly propagated in socket closing methods ([4dd97c9](https://github.com/appium/appium-ios-remotexpc/commit/4dd97c93b2411b4b26e61833c90f657338f9d928))
* Fix the reponse of diagnostics from shim service ([#42](https://github.com/appium/appium-ios-remotexpc/issues/42)) ([db157c6](https://github.com/appium/appium-ios-remotexpc/commit/db157c6ffb4f7ffbab8fd7d903544204622331c1))
* format ([055272b](https://github.com/appium/appium-ios-remotexpc/commit/055272bb3b0dcc95eeb471cfa87999d4a801d319))
* format ([d052344](https://github.com/appium/appium-ios-remotexpc/commit/d052344cdf33b91649af016700570029f2a5ff04))
* format ([acef620](https://github.com/appium/appium-ios-remotexpc/commit/acef620d195c769e8498eb51d407a4ec3a7c9015))
* improve diagnostic service response handling ([#23](https://github.com/appium/appium-ios-remotexpc/issues/23)) ([9ce0477](https://github.com/appium/appium-ios-remotexpc/commit/9ce047707ff3d51c3ec5478decb15f3c87aeb6fd))
* improve relay service lifecycle management and refactor lockdown service architecture ([#32](https://github.com/appium/appium-ios-remotexpc/issues/32)) ([d13d8f8](https://github.com/appium/appium-ios-remotexpc/commit/d13d8f83e9927f0552517c0a026973c9756ddd02))
* move away from applium/plist package and make centralised plist. also improve types ([040f1ab](https://github.com/appium/appium-ios-remotexpc/commit/040f1abbb10f1c278b28bf47bcae04ad1055410e))
* prevent numeric overflow in binary plist parser ([0c9d64d](https://github.com/appium/appium-ios-remotexpc/commit/0c9d64d052ffa8592f59bc67205601e2a6d648a8))
* Refactored services to be usable in appium-xcuitest-driver ([#40](https://github.com/appium/appium-ios-remotexpc/issues/40)) ([d8e5668](https://github.com/appium/appium-ios-remotexpc/commit/d8e566824395c4e89d722c759bc399bbc198f5aa))
* remove saving pairrecord as it has no use ([ede13a9](https://github.com/appium/appium-ios-remotexpc/commit/ede13a9baf49f664f077e635fa75c4d857783b49))
* return correct socket in getSocket ([4ea614e](https://github.com/appium/appium-ios-remotexpc/commit/4ea614e378f2d22679bc54d867e074a22904b2ef))
* rmeove duplicate piping of payload ([08953fb](https://github.com/appium/appium-ios-remotexpc/commit/08953fb3079f9d2ca5bd06edd54648659f24004a))
* stop converting data to string (expect in hex) ([9a2fb3a](https://github.com/appium/appium-ios-remotexpc/commit/9a2fb3ae0a1fd646e5ce23580b2689c402ded933))
* trim BOM if any before xml and preseve headers for _receivePlistPromise decoding ([0d3fb93](https://github.com/appium/appium-ios-remotexpc/commit/0d3fb9329a80b937a29e115749a13f506854f036))
* update pair record with proper PEM encoding ([3b30f86](https://github.com/appium/appium-ios-remotexpc/commit/3b30f8617f7393075c1a59cd7bad869d58c56bae))
* use appium/plist for pair record decode ([0b53b10](https://github.com/appium/appium-ios-remotexpc/commit/0b53b102c41f8b92e98c7d638495064c7a13a5a6))

### Miscellaneous Chores

* add missing module rimraf to dev deps ([a75e6d1](https://github.com/appium/appium-ios-remotexpc/commit/a75e6d1e277eeb4a944d72afc313cc29908423d2))
* address review comments across multiple modules ([2967d7c](https://github.com/appium/appium-ios-remotexpc/commit/2967d7cbfa1bb9fa87421bf0a35c8e43f7e3523f))
* **lint:** enforce public→protected→private order for methods ([#10](https://github.com/appium/appium-ios-remotexpc/issues/10)) ([48661de](https://github.com/appium/appium-ios-remotexpc/commit/48661de3a99f8cb1770622e392443ed8dc20b7ca))
* **maintenance:** fix top level awaits, remove unused file ([e6128a6](https://github.com/appium/appium-ios-remotexpc/commit/e6128a6d6a9cb48dc69fe23480dc13cbfb9e20d6))
* **maintenance:** set node version between >=20 <23 ([b3b8428](https://github.com/appium/appium-ios-remotexpc/commit/b3b84288be14edaddb68d57d627c91e3d0993856))
* Prepare CI for release ([#43](https://github.com/appium/appium-ios-remotexpc/issues/43)) ([e30bb6d](https://github.com/appium/appium-ios-remotexpc/commit/e30bb6d3a7ec1e047b4b161aa7c529ed5dfbd3ae))
* **refactor:** remove duplicate/dead code ([3a3f0c7](https://github.com/appium/appium-ios-remotexpc/commit/3a3f0c73368b6eb30bc089f7198317bd2b41c915))
* **refactor:** remove duplicate/dead code ([ae85b40](https://github.com/appium/appium-ios-remotexpc/commit/ae85b40578d50a772ba950a5a5ebcdc041fe7663))
* **refactor:** remove duplicate/dead code ([60127ac](https://github.com/appium/appium-ios-remotexpc/commit/60127aca350cc82146353834839a969e4581a43c))
* **refactor:** remove duplicate/dead code ([993d59f](https://github.com/appium/appium-ios-remotexpc/commit/993d59f5384efe49b4feab39ccf3dab598d51c36))
* **refactor:** use PlistService for sending and receiving data ([f358703](https://github.com/appium/appium-ios-remotexpc/commit/f358703b2bd9d9a1ce2c3e22614a028c435274f8))
* **refactor:** use PlistService for sending and receiving data ([f220b21](https://github.com/appium/appium-ios-remotexpc/commit/f220b21a596e1869f0a4822decd6ff2cbdd73915))
* remove unused import ([a9b183e](https://github.com/appium/appium-ios-remotexpc/commit/a9b183e8e0a4614d671d200ac153d9c64760eafa))
* resturucture pipeline with clear workflow ([0483440](https://github.com/appium/appium-ios-remotexpc/commit/0483440f3d752cee5755952f232e4ef92b8c9580))
* update readme doc ([5a7f02e](https://github.com/appium/appium-ios-remotexpc/commit/5a7f02ec9f080cc1204bb2cd43b3c5d8dbece1ee))
* use correct plist send request ([fd46f7f](https://github.com/appium/appium-ios-remotexpc/commit/fd46f7fb158a2b8ce42603081f9a2f83df34ed2d))

### Code Refactoring

* add explicit return type annotations and minor fixes ([808e11f](https://github.com/appium/appium-ios-remotexpc/commit/808e11f742d345406cabfa7b5a759c58a88d869e))
* improve code quality and consistency across codebase ([de1c0da](https://github.com/appium/appium-ios-remotexpc/commit/de1c0da8eb4d3b7ea765595646272647c7705aa3))
* improve resource cleanup with finally blocks and proper error handling ([1fb7659](https://github.com/appium/appium-ios-remotexpc/commit/1fb76595f178bda5baee18a8f8ba20a861469df2))
* **lockdown:** remove interactive UDID selection prompt ([921ed4d](https://github.com/appium/appium-ios-remotexpc/commit/921ed4d952543f8d52dd8bfbcc3f959fb5ca87a8))
* **logging:** adjust log levels from info to debug for operational details ([19d1b49](https://github.com/appium/appium-ios-remotexpc/commit/19d1b49f4176cab7a8c3b3e784b1b99b8d6f0512))
* move constants and bigint fixes ([6b644e4](https://github.com/appium/appium-ios-remotexpc/commit/6b644e4c6f8a83771dc7567b4f64bfaa77d396f7))
* **plist:** centralize plist implementation and remove duplication ([cee2f9d](https://github.com/appium/appium-ios-remotexpc/commit/cee2f9dce23241bccd610c4c1673b98e99feaf33))
* **plist:** extract common method for reading multi-byte integers ([7b94ced](https://github.com/appium/appium-ios-remotexpc/commit/7b94cedaa298cf84405a05820f852684e9023767))
* **plist:** improve binary plist modules and fix potential bugs ([601c024](https://github.com/appium/appium-ios-remotexpc/commit/601c024aff5a1dff1cea387ee6d72d28d3ab5173))
* refactor directories to kebab-case ([4337187](https://github.com/appium/appium-ios-remotexpc/commit/43371874bf7d9818beb66fd4a94724af7a45f037))
* remove unnecessary try/catch in TLS upgrade ([45c9e17](https://github.com/appium/appium-ios-remotexpc/commit/45c9e17a90802f86e676d41b6a3848f8caae9079))
* split binary plist code into classes ([5bdb291](https://github.com/appium/appium-ios-remotexpc/commit/5bdb2916bf2a3ef80f530f666b37cee98c3d6ec9))
* use TypeError for type-related errors ([ecef04a](https://github.com/appium/appium-ios-remotexpc/commit/ecef04afe2ecb62a7b746a6ad3444ac8904fe681))
