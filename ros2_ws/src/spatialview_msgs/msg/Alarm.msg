# 告警（接口文档 5.2）。告警码见 StatusCode 和接口文档 7.3。

string LEVEL_WARNING="WARNING"  # 不影响作业
string LEVEL_ERROR="ERROR"      # 影响作业

string code                     # 告警码（7.3）；同一 code 同时最多一条
string level                    # WARNING 或 ERROR
string detail                   # 补充说明，可为空（7.4）
builtin_interfaces/Time stamp   # 产生时间；同一告警持续期间不变
