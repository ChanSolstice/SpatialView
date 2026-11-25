"""接口约定中的取值，与 spatialview_msgs 一致（test/test_constants.py 对照 .msg 文件）。"""

INTERFACE_VERSION = "1.1"


class Robot:
    READY = "READY"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    FAULT = "FAULT"
    ESTOP = "ESTOP"
    DISABLED = "DISABLED"
    STARTING = "STARTING"
    OFFLINE = "OFFLINE"


class Camera:
    OK = "OK"
    ERROR = "ERROR"
    OFFLINE = "OFFLINE"


class Laser:
    OFF = "OFF"
    ON = "ON"
    ERROR = "ERROR"
    OFFLINE = "OFFLINE"


class Phase:
    NO_MODEL = "NO_MODEL"
    SCANNING = "SCANNING"
    RECONSTRUCTING = "RECONSTRUCTING"
    MODEL_READY = "MODEL_READY"
    PLANNING = "PLANNING"
    PLAN_READY = "PLAN_READY"
    EXECUTING = "EXECUTING"
    PAUSED = "PAUSED"
    STOPPING = "STOPPING"


class Level:
    WARNING = "WARNING"
    ERROR = "ERROR"


class Operation:
    SCAN = "SCAN"
    RECONSTRUCT = "RECONSTRUCT"
    PLAN = "PLAN"
    TASK = "TASK"
    POWER_ON = "POWER_ON"


class Outcome:
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    INTERRUPTED = "INTERRUPTED"
    STOPPED = "STOPPED"


class Command:
    START = "START"
    PAUSE = "PAUSE"
    RESUME = "RESUME"
    STOP = "STOP"


class WorkpieceType:
    REVOLVED = "REVOLVED"
    GENERAL = "GENERAL"


class Code:
    """全部状态码（接口文档第 7 节）。"""

    OK = "OK"
    INVALID_ARGUMENT = "INVALID_ARGUMENT"
    INVALID_STATE = "INVALID_STATE"
    MODEL_MISMATCH = "MODEL_MISMATCH"
    PLAN_MISMATCH = "PLAN_MISMATCH"
    INVALID_SURFACE = "INVALID_SURFACE"
    ROBOT_NOT_READY = "ROBOT_NOT_READY"
    CAMERA_NOT_READY = "CAMERA_NOT_READY"
    LASER_NOT_READY = "LASER_NOT_READY"
    INTERLOCK = "INTERLOCK"
    MODULE_UNAVAILABLE = "MODULE_UNAVAILABLE"
    DEVICE_ERROR = "DEVICE_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    PLAN_PARTIAL = "PLAN_PARTIAL"
    ROBOT_ESTOP = "ROBOT_ESTOP"
    ROBOT_FAULT = "ROBOT_FAULT"
    ROBOT_PROTECTIVE_STOP = "ROBOT_PROTECTIVE_STOP"
    ROBOT_SAFEGUARD_STOP = "ROBOT_SAFEGUARD_STOP"
    ROBOT_DISABLED = "ROBOT_DISABLED"
    ROBOT_OFFLINE = "ROBOT_OFFLINE"
    CAMERA_ERROR = "CAMERA_ERROR"
    CAMERA_OFFLINE = "CAMERA_OFFLINE"
    LASER_ERROR = "LASER_ERROR"
    LASER_OFFLINE = "LASER_OFFLINE"
    NO_VALID_DATA = "NO_VALID_DATA"
    RECONSTRUCT_ERROR = "RECONSTRUCT_ERROR"
    NO_SOLUTION = "NO_SOLUTION"
    EXPORT_ERROR = "EXPORT_ERROR"
    TIMEOUT = "TIMEOUT"
    SCAN_FAILED = "SCAN_FAILED"
    RECONSTRUCT_FAILED = "RECONSTRUCT_FAILED"
    PLAN_FAILED = "PLAN_FAILED"
    LEFTOVER_TASK_STOPPED = "LEFTOVER_TASK_STOPPED"


# ARCS 的机械臂模式和安全模式（aubo_sdk 0.27.1-rc.4 的 aubo/type_def.h，接口文档 8.2）
ROBOT_MODES = (
    "NoController",
    "Disconnected",
    "ConfirmSafety",
    "Booting",
    "PowerOff",
    "PowerOn",
    "Idle",
    "BrakeReleasing",
    "BackDrive",
    "Running",
    "Maintaince",
    "Error",
    "PowerOffing",
)
SAFETY_MODES = (
    "Undefined",
    "Normal",
    "ReducedMode",
    "Recovery",
    "Violation",
    "ProtectiveStop",
    "SafeguardStop",
    "SystemEmergencyStop",
    "RobotEmergencyStop",
    "Fault",
)
