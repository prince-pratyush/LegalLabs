import subprocess
import sys

from docproc.models import models_dir


def pytest_sessionstart(session):
    # Fetch the layout model once so a fresh checkout can run the PDF tests.
    if not any(models_dir().glob("*layout*")):
        subprocess.run([sys.executable, "-m", "docproc.prefetch"], check=True)
