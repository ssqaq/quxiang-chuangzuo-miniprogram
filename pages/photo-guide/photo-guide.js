const STEPS = [
  {
    title: "安装百度网盘",
    description: "先把百度网盘装到 iPhone 里，后面要用它保存实况图。",
    action: "现在要做：安装百度网盘",
    kind: "app",
    appTitle: "手机应用"
  },
  {
    title: "发送到文件传输助手",
    description: "回到生成页面，把 .livp 文件发送给微信里的文件传输助手。",
    action: "现在要做：发送到文件传输助手",
    kind: "send",
    appTitle: "实况图文件"
  },
  {
    title: "用其他应用打开",
    description: "打开文件后，点右上角“…”；在菜单里选择“用其他应用打开”。",
    action: "现在要做：点“用其他应用打开”",
    kind: "menu",
    appTitle: "实况图文件"
  },
  {
    title: "保存到百度网盘",
    description: "在分享菜单里选择“保存到百度网盘”，不要选其他应用。",
    action: "现在要做：选“保存到百度网盘”",
    kind: "save",
    appTitle: "实况图文件"
  },
  {
    title: "下载到相册",
    description: "回到百度网盘找到文件，点“下载到相册”，完成后就能在 iPhone 相册里看到实况图。",
    action: "最后一步：下载到相册",
    kind: "download",
    appTitle: "百度网盘"
  }
];

Page({
  data: {
    steps: STEPS
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: "图文教程" });
  }
});
