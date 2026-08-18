# Imagem da sandbox do Aurex.
#
# Como o container roda SEM REDE por padrão (proteção contra exfiltração de
# conteúdo lido de páginas web), tudo que o agente pode precisar precisa já
# estar instalado aqui — não dá para "pip install" na hora.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash coreutils procps git unzip zip \
      fonts-dejavu-core libjpeg62-turbo zlib1g libfreetype6 libpng16-16 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Usuário sem privilégios (o servidor também passa --user explicitamente)
RUN useradd -m -u 1000 -s /bin/bash sandbox

ENV MPLBACKEND=Agg \
    NODE_PATH=/usr/lib/node_modules \
    LANG=C.UTF-8

USER 1000:1000
WORKDIR /work
CMD ["bash"]
