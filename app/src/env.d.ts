/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发服务器使用的 rosbridge 地址，见 .env.development */
  readonly VITE_ROSBRIDGE_URL?: string
  /** 开发服务器使用的文件服务地址 */
  readonly VITE_HTTP_BASE_URL?: string
  /** 为 true 时打包工程入口（需求 10.3）；密码见 vite.config.ts */
  readonly VITE_ENABLE_ENGINEERING?: string
}

/** package.json 中的 APP 版本号，打包时写入 */
declare const __APP_VERSION__: string
/** 工程入口密码的 SHA-256 摘要（十六进制），打包时写入；为空表示没有设置密码 */
declare const __ENGINEERING_PASSWORD_SHA256__: string

interface ImportMeta {
  readonly env: ImportMetaEnv
}
