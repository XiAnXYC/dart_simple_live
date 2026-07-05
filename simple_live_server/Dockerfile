FROM dart:stable

# 安装 C++ 编译环境，以便 dart_quickjs FFI 插件运行构建钩子时能成功编译 C++ 依赖库
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 拷贝依赖包并保持父子目录层级结构
COPY simple_live_core/ /app/simple_live_core/
COPY simple_live_server/ /app/simple_live_server/

WORKDIR /app/simple_live_server

# 获取 Dart 依赖并触发运行 build hooks
RUN dart pub get

# 编译为自包含的 Dart Kernel AST 字节码文件，支持 build hooks 且避免运行时解析依赖
RUN dart compile kernel bin/main.dart -o bin/server.dill

EXPOSE 8080

# 启动聚合直播服务端
CMD ["dart", "bin/server.dill"]
