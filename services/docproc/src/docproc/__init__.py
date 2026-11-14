import os

# No telemetry and no model downloads while serving; prefetch flips this back.
for _key, _value in {
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "DO_NOT_TRACK": "1",
    "ANONYMIZED_TELEMETRY": "False",
}.items():
    os.environ.setdefault(_key, _value)
