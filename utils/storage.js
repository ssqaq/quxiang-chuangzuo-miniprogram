const PROJECT_KEY = "display-tool-miniapp-project-v1";
const RECORDS_KEY = "display-tool-miniapp-records-v1";

function read(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value === "" || value === undefined || value === null ? fallback : value;
  } catch (error) {
    console.warn("读取本地缓存失败", key, error);
    return fallback;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (error) {
    console.warn("写入本地缓存失败", key, error);
    return false;
  }
}

module.exports = {
  loadProject() {
    return read(PROJECT_KEY, null);
  },

  saveProject(project) {
    return write(PROJECT_KEY, project);
  },

  loadRecords() {
    return read(RECORDS_KEY, []);
  },

  saveRecords(records) {
    return write(RECORDS_KEY, records);
  },

  clearProject() {
    try {
      wx.removeStorageSync(PROJECT_KEY);
    } catch (error) {
      console.warn("清理项目缓存失败", error);
    }
  }
};
