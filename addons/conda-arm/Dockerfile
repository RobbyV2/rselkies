# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# ARM64 Portable Distribution using pip and virtual environment
ARG PY_BUILD_IMAGE=ghcr.io/robbyv2/rselkies/py-build:main
ARG WEB_IMAGE=ghcr.io/robbyv2/rselkies/gst-web:main
ARG GSTREAMER_IMAGE=ghcr.io/robbyv2/rselkies/gstreamer:main-ubuntu22.04

FROM ${PY_BUILD_IMAGE} AS selkies-build
FROM ${WEB_IMAGE} AS selkies-web
FROM ${GSTREAMER_IMAGE} AS selkies-gstreamer

# Use Ubuntu as base for ARM64 portable build
FROM ubuntu:22.04

# Package version
ARG PACKAGE_VERSION=0.0.0.dev0

SHELL ["/bin/bash", "-c"]

# Install Python and system dependencies
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3.10-venv \
    python3-pip \
    python3-dev \
    python3-gi \
    python3-gi-cairo \
    gir1.2-gtk-3.0 \
    gir1.2-gstreamer-1.0 \
    gir1.2-gst-plugins-base-1.0 \
    libcairo2-dev \
    libgirepository1.0-dev \
    libglib2.0-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    gcc \
    g++ \
    pkg-config \
    curl \
    tar \
    gzip \
    && rm -rf /var/lib/apt/lists/*

# Create portable directory structure
RUN mkdir -p /opt/selkies-arm/bin \
    /opt/selkies-arm/lib \
    /opt/selkies-arm/share \
    /opt/selkies-arm/gstreamer \
    /opt/selkies-arm/web \
    /opt/selkies-arm/python

# Copy GStreamer files from gstreamer image
COPY --from=selkies-gstreamer /opt/gstreamer /opt/selkies-arm/gstreamer

# Copy web files
COPY --from=selkies-web /opt/gst-web /opt/selkies-arm/web

# Copy Python package
COPY --from=selkies-build /opt/pypi/dist/selkies*.whl /tmp/

# Create Python virtual environment and install packages
RUN python3 -m venv /opt/selkies-arm/python/venv && \
    source /opt/selkies-arm/python/venv/bin/activate && \
    pip install --upgrade pip setuptools wheel && \
    pip install /tmp/selkies*.whl && \
    pip install \
        websockets>=13.0 \
        aiohttp>=3.7.0 \
        msgpack \
        pynput \
        psutil \
        watchdog \
        Pillow \
        prometheus_client \
        gputil \
        multidict \
        pyyaml \
        && \
    rm -f /tmp/selkies*.whl

# Create activation script
RUN cat > /opt/selkies-arm/bin/activate.sh << 'EOF'
#!/bin/bash
export SELKIES_ROOT="/opt/selkies-arm"
export PATH="${SELKIES_ROOT}/bin:${PATH}"
export LD_LIBRARY_PATH="${SELKIES_ROOT}/gstreamer/lib/aarch64-linux-gnu:${LD_LIBRARY_PATH}"
export GST_PLUGIN_PATH="${SELKIES_ROOT}/gstreamer/lib/aarch64-linux-gnu/gstreamer-1.0"
export GI_TYPELIB_PATH="${SELKIES_ROOT}/gstreamer/lib/aarch64-linux-gnu/girepository-1.0"
export PYTHONPATH="${SELKIES_ROOT}/gstreamer/lib/python3/dist-packages:${PYTHONPATH}"
export SELKIES_WEB_ROOT="${SELKIES_ROOT}/web"
source "${SELKIES_ROOT}/python/venv/bin/activate"
echo "Selkies ARM portable environment activated"
EOF

# Create launcher script
RUN cat > /opt/selkies-arm/bin/selkies << 'EOF'
#!/bin/bash
source "$(dirname "$0")/activate.sh"
python -m selkies "$@"
EOF

RUN chmod +x /opt/selkies-arm/bin/activate.sh /opt/selkies-arm/bin/selkies

# Create tarball
RUN cd /opt && \
    tar czf /opt/selkies-portable-arm.tar.gz \
        --transform 's,^selkies-arm,selkies,' \
        selkies-arm/

# Output is /opt/selkies-portable-arm.tar.gz