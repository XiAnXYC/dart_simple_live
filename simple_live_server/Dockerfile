# Stage 1 - Build
FROM dart:stable AS build

WORKDIR /app

# 拷贝依赖包并注意父子目录层级结构
COPY simple_live_core/ /app/simple_live_core/
COPY simple_live_server/ /app/simple_live_server/

WORKDIR /app/simple_live_server
RUN dart pub get
RUN dart compile exe bin/main.dart -o bin/server

# Stage 2 - Run
FROM debian:slim

WORKDIR /app

# 从构建阶段拷贝编译好的原生二进制文件
COPY --from=build /app/simple_live_server/bin/server /app/server
# 拷贝静态文件和配置文件
COPY --from=build /app/simple_live_server/config.json /app/config.json
COPY --from=build /app/simple_live_server/web /app/web

EXPOSE 8080

CMD ["/app/server"]
