ARG IMAGE=public.ecr.aws/debian/debian:trixie

FROM ${IMAGE}

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=${USER_UID}

ARG NVM_VERSION=v0.40.7
ARG NODE_VERSION=v24.20.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        sudo \
        git \
        gnupg \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        bash \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo ${USERNAME} ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

ENV NVM_DIR="/home/${USERNAME}/.nvm"
RUN mkdir -p "${NVM_DIR}" \
    && chown -R ${USERNAME}:${USERNAME} "${NVM_DIR}" \
    && su ${USERNAME} -c 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh | bash' \
    && su ${USERNAME} -c '. ${NVM_DIR}/nvm.sh && nvm install ${NODE_VERSION} && nvm alias default ${NODE_VERSION}'

ENV NVM_DIR="/home/${USERNAME}/.nvm" \
    PATH="/home/${USERNAME}/.nvm/versions/node/${NODE_VERSION}/bin:${PATH}"

USER ${USERNAME}
WORKDIR /workspace

