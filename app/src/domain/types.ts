/** domain 与 store 共用的类型（架构设计 5.2）。 */

/** APP 侧的连接状态（架构设计 5.3）。 */
export type ConnStatus = 'connecting' | 'connected' | 'reconnecting'

/** 场景模式：浏览、选面、轨迹动画。 */
export type SceneMode = 'browse' | 'select' | 'animate'

/** 模型、规划在本地的加载状态。 */
export type AssetStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 占用在途锁的指令（架构设计 5.5）。关闭激光和急停不占用，不在其中。 */
export type CommandKey =
  'scan' | 'plan' | 'start' | 'pause' | 'resume' | 'stop' | 'laserOn' | 'resetEstop'
