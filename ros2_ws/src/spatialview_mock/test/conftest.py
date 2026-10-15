"""mock 状态机的测试夹具：假时钟、假副作用，以及把系统推进到各阶段的辅助函数。"""

import pytest

from spatialview_mock.core.constants import Command, Phase
from spatialview_mock.core.machine import ExportError, MockCore, ModelFiles, PlanFiles, SimConfig

WALL_OFFSET = 1_791_790_000.0
SURFACES = {"top_00": True, "top_01": True, "wall_00": True, "back_00": False}
PLAN_DURATION = 100.0
PROCESS_INTERVALS = [(0.0, 10.0), (20.0, 90.0)]


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class FakeHooks:
    def __init__(self) -> None:
        self.published: list[dict] = []
        self.motion: list[bool] = []
        self.cleared = 0
        self.models: list[str] = []
        self.plans: list[tuple[str, str, list[str]]] = []
        self.clear_estop_result = True
        self.fail_export = False

    def publish(self, state: dict) -> None:
        self.published.append(state)

    def clear_files(self) -> None:
        self.cleared += 1

    def write_model(self, model_id: str) -> ModelFiles:
        if self.fail_export:
            raise ExportError("磁盘已满")
        self.models.append(model_id)
        return ModelFiles(f"/models/{model_id}.glb", dict(SURFACES))

    def write_plan(self, plan_id: str, model_id: str, surface_ids: list[str]) -> PlanFiles:
        if self.fail_export:
            raise ExportError("磁盘已满")
        self.plans.append((plan_id, model_id, list(surface_ids)))
        return PlanFiles(f"/plans/{plan_id}.json", PLAN_DURATION, list(PROCESS_INTERVALS))

    def set_motion(self, active: bool) -> None:
        self.motion.append(active)

    def clear_estop(self) -> bool:
        return self.clear_estop_result


class Rig:
    """被测的状态机，以及模拟的驱动状态。"""

    def __init__(self) -> None:
        self.clock = FakeClock()
        self.hooks = FakeHooks()
        self.core = MockCore(
            self.hooks,
            SimConfig(),
            clock=self.clock,
            wall_clock=lambda: WALL_OFFSET + self.clock.t,
            session_id="s1",
        )
        self.driver = dict(
            connected=True,
            robot_mode="Running",
            safety_mode="Normal",
            software_estop=False,
            motion_active=False,
            detail="",
        )
        self.driver_alive = True

    def send_driver(self, **changes) -> None:
        """驱动状态变化；与适配层一样，变化后随即推进一次，需要时立即发布。"""
        self.driver.update(changes)
        self.core.on_driver_state(**self.driver)
        self.core.tick()

    def run(self, seconds: float, step: float = 0.25) -> None:
        """推进时间；期间驱动每 step 秒发一次状态（driver_alive 为 False 时不发）。"""
        remaining = seconds
        while remaining > 1e-9:
            dt = min(step, remaining)
            self.clock.t += dt
            remaining -= dt
            if self.driver_alive:
                self.core.on_driver_state(**self.driver)
            self.core.tick()

    @property
    def state(self) -> dict:
        """当前发布的状态：先推进一次，与适配层每 50 毫秒推进一次的效果相同。"""
        self.core.tick()
        return self.core.get_state()

    def to_model_ready(self) -> None:
        assert self.core.start_scan().code == "OK"
        self.run(10.0)
        self.run(5.0)
        assert self.core.phase == Phase.MODEL_READY

    def to_plan_ready(self, surfaces: list[str] | None = None) -> None:
        self.to_model_ready()
        assert self.core.start_plan(self.core.model_id, surfaces or []).code == "OK"
        self.run(5.0)
        assert self.core.phase == Phase.PLAN_READY

    def to_executing(self) -> None:
        self.to_plan_ready()
        assert self.core.task_control(Command.START, self.core.plan_id).code == "OK"
        assert self.core.phase == Phase.EXECUTING


@pytest.fixture
def rig() -> Rig:
    r = Rig()
    r.send_driver()
    r.core.tick()
    return r
