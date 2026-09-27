# CCBGit - 超级 Git 仓库网站

双端 Node.js 全栈 Git 仓库管理网站。

## 功能特性

- 📁 仓库列表浏览
- 🌳 文件树浏览（支持目录展开/折叠）
- 📝 文件内容查看（语法高亮行号）
- 📜 提交历史分页加载
- 🔍 提交详情与差异对比
- 🌿 分支切换
- 🏷️ 标签查看
- 🎨 现代化深色主题 UI
- ⚡ 实时 Socket.io 连接

## 技术栈

**后端:**
- Express.js + TypeScript
- simple-git (Git 操作)
- Socket.io (实时通信)

**前端:**
- React 18 + TypeScript
- Vite (构建工具)
- React Router v6 (路由)
- 原生 CSS (无依赖 UI 库)

## 快速开始

### 1. 安装依赖

```bash
npm run install:all
```

### 2. 准备 Git 仓库

在项目根目录创建 `repos` 文件夹，并放入你的 Git 仓库：

```bash
mkdir -p repos
cd repos
git clone --bare https://github.com/your/repo.git
# 或直接放入现有的裸仓库
```

### 3. 启动开发环境

```bash
npm run dev
```

这将同时启动：
- 前端: http://localhost:3000
- 后端: http://localhost:3001

### 4. 生产构建

```bash
npm run build
npm run start
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REPOS_ROOT` | `../../../repos` | Git 仓库根目录路径 |
| `PORT` | `3001` | 后端服务端口 |

## 项目结构

```
CCBGit/
├── package.json              # 根配置 (monorepo)
├── packages/
│   ├── server/               # 后端
│   │   ├── src/
│   │   │   └── index.ts      # Express + Socket.io 服务
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── client/               # 前端
│       ├── src/
│       │   ├── components/   # 通用组件
│       │   ├── pages/        # 页面组件
│       │   ├── api/          # API 客户端
│       │   ├── types/        # TypeScript 类型
│       │   ├── utils/        # 工具函数
│       │   ├── styles/       # 全局样式
│       │   ├── App.tsx       # 主应用
│       │   └── main.tsx      # 入口
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
└── repos/                    # Git 仓库目录 (需手动创建)
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/repos` | 仓库列表 |
| GET | `/api/repos/:name/info` | 仓库信息 |
| GET | `/api/repos/:name/tree` | 文件树 |
| GET | `/api/repos/:name/blob` | 文件内容 |
| GET | `/api/repos/:name/commits` | 提交列表 |
| GET | `/api/repos/:name/commit/:hash` | 提交详情 |
| GET | `/api/repos/:name/diff` | 差异对比 |
| GET | `/api/repos/:name/branches` | 分支列表 |
| GET | `/api/repos/:name/tags` | 标签列表 |

## 许可证

MIT# CCBGit
# CCBGit
