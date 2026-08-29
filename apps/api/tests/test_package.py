import subprocess
import sys


def test_importing_package_submodule_does_not_import_fastapi_app() -> None:
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import flickr8k_visualizer.config; "
            "assert 'flickr8k_visualizer.main' not in sys.modules",
        ],
        check=True,
    )
