from setuptools import find_packages, setup

package_name = "spatialview_mock"

setup(
    name=package_name,
    version="1.0.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="SpatialView APP 团队",
    maintainer_email="channing53533@gmail.com",
    description="SpatialView mock 服务端和模拟驱动",
    license="Proprietary",
    entry_points={
        "console_scripts": [
            "mock_server = spatialview_mock.ros_adapter:main",
            "driver_sim = spatialview_mock.driver_sim:main",
        ],
    },
)
