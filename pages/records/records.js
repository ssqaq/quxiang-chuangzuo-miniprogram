const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const { canRepairRecord } = require("../../utils/repair");

function decorateRecord(record, cloudReady) {
  return Object.assign({}, record, {
    canRepair: canRepairRecord(record, cloudReady)
  });
}

Page({
  data: {
    records: [],
    loading: false,
    cloudReady: false,
    clearing: false,
    removingId: "",
    imagePreviewVisible: false,
    imagePreviewPath: "",
    imagePreviewTitle: "制作记录"
  },

  onShow() {
    diagnosticLog.info("records", "page-show", "打开制作记录页面");
    this.loadRecords();
  },

  backToCreate() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  },

  onPullDownRefresh() {
    this.loadRecords().finally(() => wx.stopPullDownRefresh());
  },

  async loadRecords() {
    const ready = cloud.isCloudReady();
    const localRecords = (storage.loadRecords() || [])
      .map((record) => decorateRecord(record, ready));
    diagnosticLog.info("records", "page-load-start", "开始加载制作记录页", {
      cloudReady: ready,
      localCount: localRecords.length
    });
    this.setData({ loading: true, cloudReady: ready });
    try {
      if (ready) {
        const result = await cloud.listRecords();
        const remoteRecords = ((result && result.records) || [])
          .map((record) => decorateRecord(record, ready));
        const records = remoteRecords.length ? remoteRecords : localRecords;
        this.setData({ records });
        if (remoteRecords.length) {
          storage.saveRecords(remoteRecords);
        } else if (localRecords.length) {
          console.warn("云端记录为空，保留本地制作记录", localRecords.length);
          diagnosticLog.warn("records", "cloud-empty", "云端记录为空，保留本地记录", {
            localCount: localRecords.length
          });
        }
        diagnosticLog.info("records", "page-load-success", "制作记录页加载完成", {
          remoteCount: remoteRecords.length,
          selectedCount: records.length
        });
      } else {
        this.setData({ records: localRecords });
        diagnosticLog.info("records", "page-load-local", "制作记录页使用本地记录", {
          localCount: localRecords.length
        });
      }
    } catch (error) {
      this.setData({ records: localRecords });
      diagnosticLog.error("records", "page-load-failed", "制作记录页读取云端失败", {
        error,
        localCount: localRecords.length
      });
      wx.showToast({ title: "云端读取失败，显示本地记录", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  preview(event) {
    const url = event.currentTarget.dataset.url;
    if (url) {
      this.setData({
        imagePreviewVisible: true,
        imagePreviewPath: url,
        imagePreviewTitle: "制作记录"
      });
    }
  },

  closeImagePreview() {
    this.setData({ imagePreviewVisible: false });
  },

  onImagePreviewError() {
    this.setData({ imagePreviewVisible: false });
    wx.showToast({ title: "图片加载失败，请重试", icon: "none" });
  },

  openRepair(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    const item = (this.data.records || []).find((record) => String(record.id) === id);
    if (!item || !item.canRepair) {
      wx.showToast({ title: "这条记录暂时不能进行局部修正", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/repair/repair?recordId=${encodeURIComponent(id)}`
    });
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
    diagnosticLog.info("records", "remove-start", "开始删除一条制作记录", {
      recordId: id
    });
    try {
      if (this.data.cloudReady && !String(id).startsWith("local-")) {
        await cloud.deleteRecord(id);
      }
      const records = this.data.records.filter((item) => item.id !== id);
      this.setData({ records });
      storage.saveRecords(records);
      wx.showToast({ title: "已删除", icon: "success" });
      diagnosticLog.info("records", "remove-success", "制作记录删除完成", {
        recordId: id
      });
    } catch (error) {
      diagnosticLog.error("records", "remove-failed", "制作记录删除失败", {
        recordId: id,
        error
      });
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
    diagnosticLog.info("records", "clear-start", "开始清空制作记录", {
      recordCount: records.length
    });
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
        diagnosticLog.warn("records", "clear-partial", "制作记录部分清理失败", {
          failedCount: failedRecords.length,
          totalCount: records.length
        });
        wx.showModal({
          title: "部分记录未清理",
          content: `${failedRecords.length} 条记录删除失败，已保留在列表中，请稍后重试。`,
          showCancel: false
        });
      } else {
        diagnosticLog.info("records", "clear-success", "制作记录已全部清空", {
          recordCount: records.length
        });
        wx.showToast({ title: "已清空全部记录", icon: "success" });
      }
    } catch (error) {
      this.setData({ records });
      diagnosticLog.error("records", "clear-failed", "清空制作记录失败", {
        recordCount: records.length,
        error
      });
      wx.showToast({ title: error.message || "清空失败", icon: "none" });
    } finally {
      this.setData({ clearing: false });
    }
  }
});
