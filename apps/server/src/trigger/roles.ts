/**
 * 评论闸门「是否限定角色」的判定（FR-2.4 / `docs/v21-contract.md` §1、§2）。
 *
 * 角色是**项目级预定义**的两类数据（§6.6）：按作者关联（`author_association`）或按成员。
 * 闸门只能引用名字，不能临时填人——所以判定只有一件事：**这条评论的作者命中哪些被允许的角色**。
 *
 * 四条硬规则：
 * 1. `allow_roles` 为空 = 闸门没限定角色（放行）。「要求限定角色但一个都没选」不该变成
 *    「谁都进不来」——那是配置没写完，不是要把评论全掐掉（面板侧另有保存校验兜住半成品配置）。
 * 2. 认不出的角色名**不报错**：保存时已由 `findUnknownAllowRoles()` 硬校验过，
 *    这里再做一次抛错只会在历史配置上把 webhook 打挂。
 * 3. 大小写一律不敏感：GitHub login 本身不区分大小写，`author_association` 在载荷里是大写，
 *    但配置可能被手改成小写——按值比较而不是按拼写比较。
 * 4. **成员匹配以 GitHub 用户 id 为准**（§6.6 坑一：login 会变，旧 login 会被别人注册）。
 *    login 只在「拿不到 id」时作为降级手段，且降级必须留下痕迹（`loginFallbacks`），
 *    否则「改名后权限旁路」与「正常匹配」在日志里无法区分。
 */
import type { ResolvedCommentRole } from '../config/v21-settings.ts';

/** 判定输入：角色清单 + 闸门允许的角色名 + 这条评论的作者信息。 */
export type CommentRoleMatchInput = {
  /** 项目级角色清单（`settings.comment.roles`，已摊成 `{login, id}`） */
  readonly roles: readonly ResolvedCommentRole[];
  /** 闸门允许的角色名（`gates.allow_roles`）；空 = 未限定 */
  readonly allowRoles: readonly string[];
  /** 评论载荷里的 `author_association`；`null` = 载荷没给 */
  readonly authorAssociation: string | null;
  /** 评论人 login；`null` = 载荷没给 */
  readonly authorLogin: string | null;
  /**
   * 评论人的 GitHub 用户 id；`null` / 缺省 = 载荷没给。
   *
   * 为什么允许缺：判定函数还要能服务「面板预览」与单测夹具（那里没有真实载荷）。
   * 缺 id 时成员匹配降级为 login 比对，并把这次降级记进 `loginFallbacks`。
   */
  readonly authorId?: number | null;
};

/** 降级匹配的原因：旧配置没有 id / 载荷没给 id。两者都要能被运维看见。 */
export type RoleLoginFallbackReason = 'member-without-id' | 'author-without-id';

/** 一次「按 login 降级匹配」的留痕：哪个角色、哪个 login、为什么降级。 */
export type RoleLoginFallback = {
  readonly role: string;
  readonly login: string;
  readonly reason: RoleLoginFallbackReason;
};

/** 判定结果：`matchedRoles` 是**命中的被允许角色名**（按角色清单顺序，已去重）。 */
export type CommentRoleMatch = {
  readonly allowed: boolean;
  readonly matchedRoles: readonly string[];
  /**
   * 本次判定里**按 login 降级**命中的成员（空数组 = 全部按 id 判定）。
   *
   * 为什么必须回传：降级是「本该以 id 为准但缺数据」的状态，静默通过等于把坑一
   * 重新埋回去——面板与日志要能回答「这次放行是不是靠一个可能被顶替的 login」。
   */
  readonly loginFallbacks: readonly RoleLoginFallback[];
};

/** 归一化后比较：去首尾空白 + 小写（两处都比较，避免只归一化一边）。 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** 该角色是否命中这条评论的作者；命中的降级情况记进 `fallbacks`。 */
function roleMatches(role: ResolvedCommentRole, input: CommentRoleMatchInput, fallbacks: RoleLoginFallback[]): boolean {
  if (role.by === 'association') {
    const authorAssociation = input.authorAssociation;
    if (authorAssociation === null) {
      return false;
    }
    const association = normalize(authorAssociation);
    if (association === '') {
      return false;
    }
    return role.any_of.some((allowed) => normalize(allowed) === association);
  }

  const authorLogin = input.authorLogin === null ? '' : normalize(input.authorLogin);
  const authorId = input.authorId ?? null;

  for (const member of role.members) {
    // ① id 优先：两侧都有 id 时**只比 id**，login 完全不参与。
    //    为什么不在 id 不等时再降级到 login：那样「改名后旧 login 被别人占用」的账号
    //    只要名字对得上就仍然能进——坑一原样复活。
    if (member.id !== null && authorId !== null) {
      if (member.id === authorId) {
        return true;
      }
      continue;
    }

    // ② 任一侧缺 id → 只能按 login 比，并且**必须留痕**。
    if (authorLogin === '') {
      continue;
    }
    const memberLogin = normalize(member.login);
    if (memberLogin !== '' && memberLogin === authorLogin) {
      fallbacks.push({
        role: role.name,
        login: member.login,
        reason: member.id === null ? 'member-without-id' : 'author-without-id',
      });
      return true;
    }
  }
  return false;
}

/**
 * 判定「这条评论的作者是否命中闸门允许的角色之一」。
 *
 * 为什么返回命中列表而不是布尔：日志与后台留痕要能回答「是哪个角色放行的」
 * （`webhook_deliveries.decision_reason` 只能记一个 reason，角色名属于补充证据）；
 * 面板的闸门预览也要展示同样一条信息。
 */
export function matchCommentRole(input: CommentRoleMatchInput): CommentRoleMatch {
  if (input.allowRoles.length === 0) {
    return { allowed: true, matchedRoles: [], loginFallbacks: [] };
  }
  const allowedNames = new Set(input.allowRoles.map(normalize));
  const matchedRoles: string[] = [];
  const loginFallbacks: RoleLoginFallback[] = [];
  for (const role of input.roles) {
    // 闸门只按名字引用角色；名字对不上（含拼错的历史配置）就跳过，不报错。
    if (!allowedNames.has(normalize(role.name))) {
      continue;
    }
    if (matchedRoles.includes(role.name)) {
      continue;
    }
    if (roleMatches(role, input, loginFallbacks)) {
      matchedRoles.push(role.name);
    }
  }
  return { allowed: matchedRoles.length > 0, matchedRoles, loginFallbacks };
}
