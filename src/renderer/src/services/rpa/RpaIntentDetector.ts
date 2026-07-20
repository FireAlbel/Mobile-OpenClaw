const RPA_TARGET_PATTERN = /(?:\brpa\b|\bdsl\b|自动化(?:任务|流程)|任务(?:流|编排)|工作流)/i
const PLANNING_ACTION_PATTERN =
  /(?:生成|创建|新建|编排|构建|设计|制定|输出|拆解|规划|generate|create|build|plan|compose)/i
const DIRECT_REQUEST_PATTERN = /^(?:请|帮我|给我|为我|直接|现在|立即|please\b)/i
const KNOWLEDGE_QUESTION_PATTERN =
  /^(?:如何|怎么|为什么|什么是|介绍|解释|分析|讨论|能否|可否|是否|how\b|why\b|what\b|can\b)/i

export function isRpaPlanningRequest(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || !RPA_TARGET_PATTERN.test(normalized) || !PLANNING_ACTION_PATTERN.test(normalized)) {
    return false
  }

  return DIRECT_REQUEST_PATTERN.test(normalized) || !KNOWLEDGE_QUESTION_PATTERN.test(normalized)
}
