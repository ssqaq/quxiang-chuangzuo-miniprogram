/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "profile-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露用户资料测试接口");

async function call(action, payload, openid) {
  return api.main(Object.assign({
    action,
    requestId: `profile-smoke-${action}-${Date.now()}`
  }, payload || {}), {
    OPENID: openid
  });
}

async function main() {
  test.resetUserProfileTestRows();

  const anonymous = await call("getMyUserProfile", {}, "anonymous");
  assert.strictEqual(anonymous.ok, false);
  assert.strictEqual(anonymous.errorCode, "wechat-binding-required");

  const missingAvatar = await call("saveMyUserProfile", {
    profile: { nickname: "测试用户", gender: "male" }
  }, "profile-user-1");
  assert.strictEqual(missingAvatar.ok, false);
  assert.strictEqual(missingAvatar.errorCode, "USER_PROFILE_INVALID");

  const missingNickname = await call("saveMyUserProfile", {
    profile: { avatarFileID: "cloud://test/avatar-1.jpg", gender: "male" }
  }, "profile-user-1");
  assert.strictEqual(missingNickname.ok, false);

  const invalidGender = await call("saveMyUserProfile", {
    profile: {
      nickname: "测试用户",
      avatarFileID: "cloud://test/avatar-1.jpg",
      gender: "unknown"
    }
  }, "profile-user-1");
  assert.strictEqual(invalidGender.ok, false);

  for (let index = 1; index <= 23; index += 1) {
    const result = await call("saveMyUserProfile", {
      profile: {
        nickname: `用户${index}`,
        avatarFileID: `cloud://test/avatar-${index}.jpg`,
        gender: index <= 12 ? "male" : "female"
      }
    }, `profile-user-${index}`);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.completed, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(result.profile, "openid"));
  }

  const mine = await call("getMyUserProfile", {}, "profile-user-1");
  assert.strictEqual(mine.ok, true);
  assert.strictEqual(mine.completed, true);
  assert.strictEqual(mine.profile.gender, "male");
  assert.ok(!Object.prototype.hasOwnProperty.call(mine.profile, "openid"));

  const forbidden = await call("getAdminUserStats", {
    offset: 0,
    limit: 20
  }, "profile-user-1");
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  const firstPage = await call("getAdminUserStats", {
    offset: 0,
    limit: 20
  }, "profile-admin");
  assert.strictEqual(firstPage.ok, true);
  assert.strictEqual(firstPage.total, 23);
  assert.strictEqual(firstPage.maleCount, 12);
  assert.strictEqual(firstPage.femaleCount, 11);
  assert.strictEqual(firstPage.maleRatio + firstPage.femaleRatio, 100);
  assert.strictEqual(firstPage.users.length, 20);
  assert.strictEqual(firstPage.nextOffset, 20);
  firstPage.users.forEach((item) => {
    assert.ok(!Object.prototype.hasOwnProperty.call(item, "openid"));
    assert.match(item.userHash, /^[0-9a-f]{12}$/);
  });

  const secondPage = await call("getAdminUserStats", {
    offset: firstPage.nextOffset,
    limit: 20
  }, "profile-admin");
  assert.strictEqual(secondPage.ok, true);
  assert.strictEqual(secondPage.users.length, 3);
  assert.strictEqual(secondPage.nextOffset, null);

  const rawRows = test.getUserProfileTestRows();
  assert.strictEqual(rawRows.length, 23);
  assert.ok(rawRows.every((item) => ["male", "female"].includes(item.gender)));

  console.log("user profile smoke: OK (required-fields/gender/admin/paging/privacy)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
