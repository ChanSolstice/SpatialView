from tools.soak.trend import growth, keeps_growing, slope_per_hour


def test_slope_per_hour():
    assert slope_per_hour([0, 1800, 3600], [10, 15, 20]) == 10
    assert slope_per_hour([0], [5]) == 0


def test_growth_ignores_warmup():
    # 前 3 轮热身时内存上升，之后平稳
    values = [50, 80, 100, 101, 99, 100, 102, 100, 101, 99]
    assert abs(growth(values, warmup=3)) < 0.02
    assert not keeps_growing(values, warmup=3)


def test_keeps_growing_detects_leak():
    values = [100 + 5 * i for i in range(20)]
    assert keeps_growing(values, warmup=2)
