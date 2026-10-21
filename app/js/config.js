/* deploy.sh 打包前写入、打包后改回空值：仓库里不存地址和凭证（凭证在 ~/.telegram-tizen.conf）。 */
var REPORT_TO = "";
var TG_API_ID = 0;
var TG_API_HASH = "";
/* release.sh 只在发布包里写：这个项目那组 API ID / Hash，打乱过、不是明文（见 apikey.js）。仓库里永远是空的。 */
var TG_API_PACKED = "";
