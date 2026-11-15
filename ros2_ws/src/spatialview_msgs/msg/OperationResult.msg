# 操作结果（接口文档 5.3）。可能出现的组合见接口文档 8.7，原因码见 7.2。

string OPERATION_SCAN="SCAN"
string OPERATION_RECONSTRUCT="RECONSTRUCT"
string OPERATION_PLAN="PLAN"
string OPERATION_TASK="TASK"
string OPERATION_POWER_ON="POWER_ON"

string RESULT_SUCCEEDED="SUCCEEDED"
string RESULT_FAILED="FAILED"
string RESULT_INTERRUPTED="INTERRUPTED"
string RESULT_STOPPED="STOPPED"

string id                       # 每个结果唯一，服务端重启后也不重复，例如 "<session_id>-<序号>"
string operation                # SCAN RECONSTRUCT PLAN TASK POWER_ON
string result                   # SUCCEEDED FAILED INTERRUPTED STOPPED
string code                     # 原因码（7.2）；没有需要说明的原因时为空
string detail                   # 补充说明，可为空（7.4）
builtin_interfaces/Time stamp   # 操作结束时间
