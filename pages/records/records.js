const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");

Page({
  data: {
    records: [],
    loading: false,
    cloudReady: false,
    clearing: false,
    removingId: ""
  },

  onShow() {
    this.loadRecords();
  },

  backToCreate() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/index/index" })
    });
  },

  onPullDownRefresh() {
    this.loadRecords().finally(() => wx.stopPullDownRefresh());
  },

  async loadRecords() {
    const ready = cloud.isCloudReady();
    const localRecords = storage.loadRecords() || [];
    this.setData({ loading: true, cloudReady: ready });
    try {
      if (ready) {
        const result = await cloud.listRecords();
        const remoteRecords = (result && result.records) || [];
        const records = remoteRecords.length ? remoteRecords : localRecords;
        this.setData({ records });
        if (remoteRecords.length) {
          storage.saveRecords(remoteRecords);
        } else if (localRecords.length) {
          console.warn("云端记录为空，保留本地制作记录", localRecords.length);
        }
      } else {
        this.setData({ records: localRecords });
      }
    } catch (error) {
      this.setData({ records: localRecords });
      wx.showToast({ title: "云端读取失败，显示本地记录", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  preview(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },

  async remove(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.clearing || this.data.removingId) return;
    const response = await new Promise((resolve) => {
      wx.showModal({
        title: "删除这条记录？",
        content: "云端图片和记录会一起删除。",
        success: resolve
      });
    });
    if (!response.confirm) return;
    this.setData({ removingId: id });
    try {
      if (this.data.cloudReady && !String(id).startsWith("local-")) {
        await cloud.deleteRecord(id);
      }
      const records = this.data.records.filter((item) => item.id !== id);
      this.setData({ records });
      storage.saveRecords(records);
      wx.showToast({ title: "已删除", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "删除失败", icon: "none" });
    } finally {
      this.setData({ removingId: "" });
    }
  },

  async clearAll() {
    const records = this.data.records || [];
    if (!records.length || this.data.clearing || this.data.removingId) return;
    const response = await new Promise((resolve) => {
      wx.showModal({
        title: "清空全部制作记录？",
        content: `将删除 ${records.length} 条记录及云端图片，删除后无法恢复。`,
        confirmText: "清空全部",
        confirmColor: "#d33d3d",
        success: resolve
      });
    });
    if (!response.confirm) return;

    this.setData({ clearing: true });
    const remoteRecords = this.data.cloudReady
      ? records.filter((item) => item.id && !String(item.id).startsWith("local-"))
      : [];
    try {
      const results = await Promise.all(remoteRecords.map(async (item) => {
        try {
          await cloud.deleteRecord(item.id);
          return null;
        } catch (error) {
          return item;
        }
      }));
      const failedRecords = results.filter(Boolean);
      this.setData({ records: failedRecords });
      storage.saveRecords(failedRecords);
      if (failedRecords.length) {
        wx.showModal({
          title: "部分记录未清理",
          content: `${failedRecords.length} 条记录删除失败，已保留在列表中，请稍后重试。`,
          showCancel: false
        });
      } else {
        wx.showToast({ title: "已清空全部记录", icon: "success" });
      }
    } catch (error) {
      this.setData({ records });
      wx.showToast({ title: error.message || "清空失败", icon: "none" });
    } finally {
      this.setData({ clearing: false });
    }
  }
});
