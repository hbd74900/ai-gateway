# AI Gateway

OpenAI 兼容的 API 代理网关，部署在 Cloudflare Worker 上。支持多上游服务、多 Key 负载均衡、Web 管理面板。

## 功能

- **多上游渠道**：支持配置多个不同的 AI 服务（NVIDIA NIM、OpenRouter、Azure 等）
- **负载均衡**：优先级分组 + 加权随机 + 渠道内 Key 轮询
- **自动故障转移**：上游 5xx 或网络错误时自动切换到下一个 Key/渠道
- **Web 管理面板**：可视化管理渠道、Key，无需改代码
- **API Key 鉴权**：生成客户端 API Key，控制代理访问权限
- **OpenAI 兼容**：支持 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`
- **流式支持**：完整支持 SSE 流式响应

## 快速部署

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- Cloudflare 账号

### 步骤

```bash
# 1. 克隆项目
git clone <repo-url> ai-gateway
cd ai-gateway

# 2. 安装依赖
npm install

# 3. 创建 KV 命名空间
npx wrangler kv namespace create "AI_GATEWAY"
# 输出类似: { binding = "KV", id = "xxxxxxxxxxxx" }

# 4. 更新 wrangler.toml 中的 KV namespace id
# 把上一步输出的 id 替换进 wrangler.toml

# 5. 设置管理密码（作为 Secret，不会出现在代码中）
npx wrangler secret put ADMIN_PASSWORD
# 输入你的管理密码

# 6. 部署
npm run deploy
```

### 本地开发

```bash
# 创建 .dev.vars 文件（不会被 git 提交）
echo ADMIN_PASSWORD=dev-password > .dev.vars

# 启动本地开发服务器
npm run dev
```

## 使用方法

### 1. 配置渠道

访问 `https://your-worker.workers.dev/admin`，使用管理密码登录。

- 进入 **Channels** 页面
- 点击 **Add Channel**
- 填写上游服务信息：
  - **Name**: 渠道名称（如 "NVIDIA NIM"）
  - **Base URL**: 上游 API 地址（如 `https://integrate.api.nvidia.com/v1`）
  - **API Keys**: 上游的 API Key，每行一个
  - **Models**: 该渠道支持的模型，每行一个（留空表示接受所有模型）
  - **Priority**: 优先级（数字越小越优先）
  - **Weight**: 权重（同优先级内的流量分配比例）

### 2. 生成客户端 API Key

- 进入 **API Keys** 页面
- 点击 **Generate Key**
- 复制生成的 Key

### 3. 调用 API

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-generated-key" \
  -d '{
    "model": "meta/llama-3.1-405b-instruct",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

支持在任何兼容 OpenAI API 的客户端中使用：
- **API Base URL**: `https://your-worker.workers.dev/v1`
- **API Key**: 管理面板中生成的 Key
- **Model**: 在渠道中配置的模型名

## 负载均衡策略

```
请求到达
  ↓
按模型筛选可用渠道
  ↓
按优先级分组（Priority 0 → 1 → 2 → ...）
  ↓
同优先级内按 Weight 加权随机排序
  ↓
渠道内 Key 轮询（Round-Robin）
  ↓
发送请求 → 成功则返回
  ↓ 失败（5xx / 网络错误）
尝试下一个 Key → 下一个渠道 → 下一个优先级组
  ↓ 全部失败
返回 502 错误
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 健康检查 |
| GET | `/admin` | 管理面板 |
| POST | `/v1/chat/completions` | 聊天补全（支持流式） |
| POST | `/v1/embeddings` | 文本嵌入 |
| GET | `/v1/models` | 模型列表 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 管理面板登录密码（通过 `wrangler secret put` 设置） |

## 架构

```
src/
├── index.js           # Worker 入口 + 路由
├── admin/
│   ├── auth.js        # 管理员认证（HMAC Token）
│   ├── api.js         # 管理 CRUD API
│   └── page.js        # 管理面板 SPA
├── proxy/
│   ├── auth.js        # 客户端 API Key 校验
│   └── handler.js     # 代理转发 + 故障转移
├── lb/
│   └── balancer.js    # 负载均衡调度器
└── store/
    └── kv.js          # KV 存储（带内存缓存）
```

## License

MIT
