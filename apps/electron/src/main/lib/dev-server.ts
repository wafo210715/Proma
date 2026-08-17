/**
 * 开发服务器地址解析。
 *
 * 默认端口 5173；设置 PROMA_DEV_PORT 可让多个 Proma 开发检出并行运行
 * （搭配 PROMA_DEV_INSTANCE 隔离 userData / app name，二者共同构成
 * 多 dev 实例隔离：进程名与端口不再互抢）。
 */
export const DEV_SERVER_PORT = Number(process.env.PROMA_DEV_PORT) || 5173

/** dev server 的 origin（Electron 各窗口 loadURL 与 web security 白名单统一引用） */
export const DEV_SERVER_ORIGIN = `http://127.0.0.1:${DEV_SERVER_PORT}`

/** 生成 dev server 渲染入口 URL，query 形如 `?window=quick-task` */
export const rendererDevUrl = (query: string): string => `${DEV_SERVER_ORIGIN}${query}`
