# Menu image analysis: everything (libraries + model weights) is baked into this image,
# so a run only has to pull the image and start scoring. Built by menu-image-build.yml.
FROM python:3.11-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 TORCH_HOME=/models/torch HF_HOME=/models/hf XDG_CACHE_HOME=/models/cache
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY prefetch.py ./
# download every model once, at build time (cached, so code-only changes rebuild in about a minute)
RUN python prefetch.py
COPY analyze.py ./
CMD ["python", "/app/analyze.py"]
