# CPU Lab · 串口数据看板

静态网页，无需安装 npm 依赖。源文件和部署文件都位于 `dist/`。

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

## 板上报文

每行发送一个 UTF-8 JSON 对象，以换行结束：

```json
{"seq":1,"input":120,"result":85,"status":0,"gpio_in":3,"gpio_out":1,"gpio_dir":1}
```

- `input`、`result`：必填，有限数值。
- `seq`：可选，非负安全整数序号。
- `status`：可选，非负安全整数；0 表示正常，其他值原样显示。
- `gpio_in`、`gpio_out`、`gpio_dir`：可选，32 位无符号整数。
  方向位 0 表示输入、1 表示输出；页面显示前 8 个引脚及完整 32 位位图。
  输出引脚显示输出锁存值，输入引脚显示输入电平。方向未提供时显示输入位图
  并标记方向未知。没有提供电平字段时显示未知，不能当作低电平。

普通文本日志在「原始报文」里展示，不计入数据帧。无效 JSON、错误字段、超长
报文计入异常报文数。每行最多 8192 字符，支持串口分块、CRLF 和 UTF-8 分块。
未以换行结束的最后一条报文不提交；断开时丢弃不完整行。

现有 AM 程序可以使用：

```c
#include <klib.h>

/* 放在实际采集/处理完成后；seq/input/result 为程序中的整数变量。 */
printf("{\"seq\":%u,\"input\":%d,\"result\":%d,\"status\":0}\n",
       seq, input, result);
```

现有 AM 格式化输出不提供浮点格式，板上可发送整数或采用约定的定点单位。
只有实现 GPIO 硬件后才可读取 GPIO 寄存器并发送相应字段。

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
