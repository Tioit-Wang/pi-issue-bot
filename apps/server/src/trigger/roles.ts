/**
 * 评论闸门「是否限定角色」的判定（FR-2.4 / `docs/v21-contract.md` §1、§2）。
 *
 * 角色是**项目级预定义**的两类数据（§6.6）：按作者关联（`author_association`）或按成员 login。
 * 闸门只能引用名字，不能临时填人——所以判定只有一件事：**这条评论的作者命中哪些被允许的角色**。
 *
 * 三条硬规则：
 * 1. `allow_roles` 为空 = 闸门没限定角色（放行）。「要求限定角色但一个都没选」不该变成
 *    「谁都进不来」——那是配置没写完，不是要把评论全掐掉（面板侧另有保存校验兜住半成品配置）。
 * 2. 认不出的角色名**不报错**：保存时已由 `findUnknownAllowRoles()` 硬校验过，
 *    这里再做一次抛错只会在历史配置上把 webhook 打挂。
 * 3. 大小写一律不敏感：GitHub login 本身不区分大小写，`author_association` 在载荷里是大写，
 *    但配置可能被手改成小写——按值比较而不是按拼写比较。
 */
import type { CommentRole } from '../../../../packages/contract/src/index.ts';

/** 判定输入：角色清单 + 闸门允许的角色名 + 这条评论的作者信息。 */
export type CommentRoleMatchInput = {
  /** 项目级角色清单（`settings.comment.roles`） */
  readonly roles: readonly CommentRole[];
  /** 闸门允许的角色名（`gates.allow_roles`）；空 = 未限定 */
  readonly allowRoles: readonly string[];
  /** 评论载荷里的 `author_association`；`null` = 载荷没给 */
  readonly authorAssociation: string | null;
  /** 评论人 login；`null` = 载荷没给 */
  readonly authorLogin: string | null;
};

/** 判定结果：`matchedRoles` 是**命中的被允许角色名**（按角色清单顺序，已去重）。 */
export type CommentRoleMatch = {
  readonly allowed: boolean;
  readonly matchedRoles: string[];
};

/** 归一化后比较：去首尾空白 + 小写（两处都比较，避免只归一化一边）。 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** 该角色是否命中这条评论的作者。 */
function roleMatches(role: CommentRole, authorAssociation: string | null, authorLogin: string | null): boolean {
  if (role.by === 'association') {
    if (authorAssociation === null) {
      return false;
    }
    const association = normalize(authorAssociation);
    if (association === '') {
      return false;
    }
    return role.any_of.some((allowed) => normalize(allowed) === association);
  }
  if (authorLogin === null) {
    return false;
  }
  const login = normalize(authorLogin);
  if (login === '') {
    return false;
  }
  return role.members.some((member) => normalize(member) === login);
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
    return { allowed: true, matchedRoles: [] };
  }
  const allowedNames = new Set(input.allowRoles.map(normalize));
  const matchedRoles: string[] = [];
  for (const role of input.roles) {
    // 闸门只按名字引用角色；名字对不上（含拼错的历史配置）就跳过，不报错。
    if (!allowedNames.has(normalize(role.name))) {
      continue;
    }
    if (matchedRoles.includes(role.name)) {
      continue;
    }
    if (roleMatches(role, input.authorAssociation, input.authorLogin)) {
      matchedRoles.push(role.name);
    }
  }
  return { allowed: matchedRoles.length > 0, matchedRoles };
}
