const PROJECT_KEY = "display-tool-miniapp-project-v1";
const RECORDS_KEY = "display-tool-miniapp-records-v1";
const PHOTO_TO_VIDEO_CLEANUP_KEY = "display-tool-photo-to-video-cleanup-v1";
const PHOTO_TO_VIDEO_SESSION_KEY = "display-tool-photo-to-video-session-v1";

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

  loadPhotoToVideoCleanup() {
    return read(PHOTO_TO_VIDEO_CLEANUP_KEY, []);
  },

  savePhotoToVideoCleanup(items) {
    return write(PHOTO_TO_VIDEO_CLEANUP_KEY, items);
  },

  loadPhotoToVideoSession() {
    return read(PHOTO_TO_VIDEO_SESSION_KEY, null);
  },

  savePhotoToVideoSession(session) {
    return write(PHOTO_TO_VIDEO_SESSION_KEY, session);
  },

  clearPhotoToVideoSession() {
    try {
      wx.removeStorageSync(PHOTO_TO_VIDEO_SESSION_KEY);
    } catch (error) {
      console.warn("清理照片转视频会话缓存失败", error);
    }
  },

  removeRecordsByIds(recordIds) {
    const ids = new Set((Array.isArray(recordIds) ? recordIds : []).map(String));
    if (!ids.size) return [];
    const records = this.loadRecords() || [];
    const retained = records.filter((record) => !ids.has(String(record && (record.id || record._id) || "")));
    this.saveRecords(retained);
    const project = this.loadProject();
    if (project && Array.isArray(project.results)) {
      this.saveProject(Object.assign({}, project, {
        results: project.results.filter(
          (record) => !ids.has(String(record && (record.id || record._id) || ""))
        )
      }));
    }
    return retained;
  },

  clearProject() {
    try {
      wx.removeStorageSync(PROJECT_KEY);
    } catch (error) {
      console.warn("清理项目缓存失败", error);
    }
  }
};
