# CPU Lab · 串口数据看板

静态网页，无需安装 npm 依赖。源文件和部署文件都位于 `dist/`。

数据链路：外部设备 → GPIO 输入 FPGA → FPGA 内 CPU 裸机处理 → UART 输出
处理结果 → USB 转串口 → 电脑网页。网页读取结果串口，不连接 GPIO，也不要求
板子发送原始输入或引脚位图。

## 本地使用

```sh
cd /home/ripplish/sites/cpu-serial-monitor
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

在电脑浏览器中打开 `http://localhost:8080`。推荐使用提供 Web Serial 的桌面
浏览器（例如 Chrome 或 Edge）；网页会检查 API 是否可用。串口只在用户点击
连接并授权后打开。HTTPS 部署地址也能使用；内嵌预览不提供串口权限时请在
独立标签页打开。网络服务不接收串口数据，所有采集数据都在当前标签页内存中。
刷新页面会清空记录。

## 发布到 GitHub Pages

工程已包含 `.github/workflows/pages.yml`，推送到 GitHub 仓库的 `main` 分支后，
可以自动发布 `dist/` 中的网页。

1. 在 GitHub 创建公开仓库，将工程推送到该仓库的 `main` 分支。
2. 打开仓库的 **Settings → Pages**，将 **Build and deployment → Source**
   设置为 **GitHub Actions**。
3. 打开 **Actions → Deploy website to GitHub Pages → Run workflow**，选择
   `main` 分支运行。之后推送到 `main` 会自动更新网站。
4. 发布成功后，在 **Settings → Pages** 或工作流的 `github-pages` 部署环境中
   复制实际网站地址，发给其他人即可访问。

项目网站地址通常为 `https://你的用户名.github.io/仓库名/`，以 GitHub 显示的
实际地址为准。网页资源使用相对路径，可部署在仓库子路径下。
访问者可以运行模拟演示；连接真实设备时，需要在自己的电脑上使用支持
Web Serial 的桌面浏览器，并接好自己的串口设备。

## 板上报文

每行发送一个 UTF-8 JSON 对象，以换行结束：

```json
{"seq":1,"result":85,"status":0}
```

- `result`：唯一必填字段，有限数值。最小报文为 `{"result":85}`。
- `seq`：可选，非负安全整数序号。
- `status`：可选，非负安全整数；0 表示正常，其他值原样显示。
- 其他字段不参与展示。未提供的序号或状态不会被当作 0。

普通文本日志在「原始报文」里展示，不计入数据帧。无效 JSON、错误字段、超长
报文计入异常报文数。每行最多 8192 字符，支持串口分块、CRLF 和 UTF-8 分块。
未以换行结束的最后一条报文不提交；断开时丢弃不完整行。

现有 AM 程序可以使用：

```c
#include <klib.h>

/* 外部数据经 GPIO 读取并处理完成后；seq/result 为程序中的整数变量。 */
printf("{\"seq\":%u,\"result\":%d,\"status\":0}\n", seq, result);
```

现有 AM 格式化输出不提供浮点格式，板上可发送整数或采用约定的定点单位。
只有实现 GPIO 硬件后才可读取 GPIO 寄存器；GPIO 数据在 FPGA 内由程序处理，
UART 只需要输出处理结果。

## 行为与限制

模拟演示以 10 帧/秒生成数据，界面和导出的 `source=demo` 均明确标识模拟来源。
新连接或新演示清空上次会话；断开设备后保留数据。暂停冻结显示，但继续采集。
保留最近 10,000 帧，CSV 导出当前保留记录；原始报文最多保留最近 120 行。
图表可显示最近 60、120 或 300 帧，纵轴自动缩放。

UART 默认 115200、8N1、无流控，应与板上配置一致。接线为 FPGA UART TX →
USB 转串口 RX，GND 共地，并使用电平兼容的模块。其他串口工具应先释放端口。

## 检查

```sh
node --test tests/*.test.mjs
node --check dist/app.mjs
```

协议和串口生命周期用内置 Node 测试验证；真实串口需要接好板子后进行端到端验证。
Web Serial 参考：https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
