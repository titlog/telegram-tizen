/* deploy.sh 打包前写入、打包后改回空值：仓库里不存地址和凭证（凭证在 ~/.telegram-tizen.conf）。 */
var REPORT_TO = "";
var TG_API_ID = 0;
var TG_API_HASH = "";
/* deploy.sh 在设了 TG_UPDATE_MANIFEST 时写入，打包后改回空串：开发构建去这里查更新（在电视上测自动更新）。只有 REPORT_TO 非空的构建认它。 */
var UPDATE_MANIFEST = "";
/* deploy.sh 在设了 TG_DIAG_TO（或 --diag）时写入，打包后改回空串。空着就传到 diag.js 里的 ENDPOINT，和发布包一样；"off" 不传；
 * 别的地址就传到那里（--diag：本机冒充的接收端）。自测构建一律不传。 */
var DIAG_TO = "";
/* deploy.sh --diag 打包时写 "diag"（js/selftest.js 跑那一段），打包后改回空串。 */
var SELFTEST = "";
/* release.sh 只在发布包里写：这个项目那组 API ID / Hash，打乱过、不是明文（见 apikey.js）。仓库里永远是空的。 */
var TG_API_PACKED = "";
