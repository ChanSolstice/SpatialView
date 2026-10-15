"""校验结果：逐条记录错误、警告和信息。"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field

LEVEL_TEXT = {"error": "错误", "warning": "警告", "info": "信息"}

# 同一级别、同一代码的问题只详细列出前几处，其余计数，避免几万个点刷屏
MAX_DETAILS_PER_CODE = 5


@dataclass
class Issue:
    level: str
    code: str
    message: str

    def format(self) -> str:
        return f"[{LEVEL_TEXT[self.level]}] {self.code} {self.message}"


@dataclass
class Report:
    subject: str
    issues: list[Issue] = field(default_factory=list)
    _counts: Counter = field(default_factory=Counter, repr=False)

    def add(self, level: str, code: str, message: str) -> None:
        self._counts[(level, code)] += 1
        if self._counts[(level, code)] <= MAX_DETAILS_PER_CODE:
            self.issues.append(Issue(level, code, message))

    def error(self, code: str, message: str) -> None:
        self.add("error", code, message)

    def warning(self, code: str, message: str) -> None:
        self.add("warning", code, message)

    def info(self, code: str, message: str) -> None:
        self.add("info", code, message)

    def count(self, level: str) -> int:
        return sum(n for (lv, _), n in self._counts.items() if lv == level)

    @property
    def ok(self) -> bool:
        return self.count("error") == 0

    def codes(self, level: str | None = None) -> set[str]:
        return {code for (lv, code) in self._counts if level is None or lv == level}

    def _omitted(self) -> list[tuple[str, str, int]]:
        return [
            (level, code, n - MAX_DETAILS_PER_CODE)
            for (level, code), n in self._counts.items()
            if n > MAX_DETAILS_PER_CODE
        ]

    def format(self) -> str:
        lines = [f"校验 {self.subject}"]
        lines += [f"  {issue.format()}" for issue in self.issues]
        for level, code, more in self._omitted():
            lines.append(f"  [{LEVEL_TEXT[level]}] {code} 另有 {more} 处")
        lines.append(f"  结果：{self.count('error')} 个错误，{self.count('warning')} 个警告")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "subject": self.subject,
            "errors": self.count("error"),
            "warnings": self.count("warning"),
            "issues": [asdict(i) for i in self.issues],
            "omitted": [{"level": lv, "code": c, "count": n} for lv, c, n in self._omitted()],
        }
