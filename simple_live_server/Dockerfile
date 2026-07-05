FROM dart:stable

WORKDIR /app

# 拷贝依赖包并保持父子目录层级结构
COPY simple_live_core/ /app/simple_live_core/
COPY simple_live_server/ /app/simple_live_server/

WORKDIR /app/simple_live_server

# 获取 Dart 依赖包
RUN dart pub get

EXPOSE 8080

# 运行服务
CMD ["dart", "run", "bin/main.dart"]
