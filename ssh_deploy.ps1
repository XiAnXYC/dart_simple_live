$sshPath = "c:\Users\admin\Documents\AI\live\.mingit\usr\bin\ssh.exe"
$askpassPath = "c:\Users\admin\Documents\AI\live\askpass.sh"

# 1. 写入 askpass.sh 密码输出文件，换行符保持 LF
$shCode = "#!/bin/sh`necho 'Xu725611(@@)'"
[System.IO.File]::WriteAllText($askpassPath, $shCode)

# 2. 转换 POSIX 路径并配置 OpenSSH ASKPASS 强制环境变量
$posixAskpass = $askpassPath.Replace("\", "/").Replace("c:", "/c").Replace("C:", "/c")
$env:SSH_ASKPASS = $posixAskpass
$env:SSH_ASKPASS_REQUIRE = "force"
$env:DISPLAY = "dummydisplay:0"

Write-Output "==== STARTING SILENT DOCKER DEPLOYMENT ON VM (10.0.0.20) ===="

# 3. 构造提权宏
$sudoDocker = "echo 'Xu725611(@@)' | sudo -S docker"

# 4. 映射端口从 8080:8080 改为 8089:8080 避开虚拟机 8080 端口冲突
$commandsArray = @(
    "echo '---- VM Environment Info ----'",
    "uname -a",
    "($sudoDocker --version)",
    "echo '---- Syncing repository from GitHub ----'",
    "if [ ! -d 'dart_simple_live' ]; then git clone https://github.com/XiAnXYC/dart_simple_live.git; fi",
    "cd dart_simple_live",
    "git fetch origin",
    "git reset --hard origin/master",
    "echo '---- Preparing independent global config path ----'",
    "mkdir -p /home/ubuntu/simple_live_config",
    "if [ ! -f '/home/ubuntu/simple_live_config/config.json' ]; then cp simple_live_server/config.json /home/ubuntu/simple_live_config/config.json; fi",
    "echo '---- Building lightweight multi-stage Docker image ----'",
    "($sudoDocker build -t simple-live-web -f simple_live_server/Dockerfile .)",
    "echo '---- Deploying container ----'",
    "($sudoDocker rm -f simple-live-web || true)",
    "($sudoDocker run -d --name simple-live-web --restart unless-stopped -p 8089:8080 -v /home/ubuntu/simple_live_config/config.json:/app/simple_live_server/config.json simple-live-web)",
    "echo '---- Verifying deployed containers ----'",
    "($sudoDocker ps)",
    "echo '---- Showing simple-live-web startup logs ----'",
    "sleep 4",
    "($sudoDocker logs simple-live-web)"
)

$remoteCommands = $commandsArray -join " && "

# 5. 发起非交互式 SSH 连接并获取回传结果，合并 stderr
$result = $null | & $sshPath -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@10.0.0.20 $remoteCommands 2>&1

Write-Output "==== VM EXECUTION RESULTS ===="
Write-Output $result

# 6. 清理本地密码临时文件
if (Test-Path $askpassPath) { Remove-Item $askpassPath }
