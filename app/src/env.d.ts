/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发服务器使用的 rosbridge 地址，见 .env.development */
  readonly VITE_ROSBRIDGE_URL?: string
  /** 开发服务器使用的文件服务地址 */
  readonly VITE_HTTP_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
