import { expect, test } from '@playwright/test'

const overviewPath = '/api/v1/workspaces/demo_workspace/projects/demo_project/operator-overview'
const messagesPath = '/api/v1/workspaces/demo_workspace/conversations/demo_project%3Aconversation%3Ateam/messages'

async function openTeamRoom(page) {
  await page.goto('/')
  await selectDemoWorkspace(page)
}

async function selectDemoWorkspace(page) {
  await expect(page.getByRole('heading', { name: '选择一个 Agent 团队开始工作', exact: true })).toBeVisible()
  await page.locator('.workspace-card__open', { hasText: 'RunGuild 演示项目' }).click()
  await expect(page.getByRole('heading', { name: '和 Agent 团队一起工作', exact: true })).toBeVisible()
  await expect(page.locator('.composer-field textarea')).toBeVisible()
}

async function operatorOverview(page) {
  const response = await page.request.get(overviewPath)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

test('a greeting stays a message and a task starts planning without a second manual action', async ({ page }) => {
  await openTeamRoom(page)
  const missionsBefore = (await operatorOverview(page)).missions.length

  const composer = page.locator('.composer-field textarea')
  const greeting = `你好，浏览器验收 ${Date.now()}`
  await composer.fill(greeting)
  await expect(page.locator('.composer-intent button', { hasText: '普通消息' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '发送普通消息', exact: true }).click()
  await expect(page.locator('.message-stream').getByText(greeting, { exact: true })).toBeVisible()
  expect((await operatorOverview(page)).missions.length).toBe(missionsBefore)

  const messagesResponse = await page.request.get(messagesPath)
  expect(messagesResponse.ok()).toBeTruthy()
  const greetingRecord = (await messagesResponse.json()).messages.find((message) => message.body === greeting)
  expect(greetingRecord).toBeTruthy()
  expect(greetingRecord.entityRefs.missionId).toBeUndefined()

  const task = `帮我创建浏览器验收页面 ${Date.now()}`
  await composer.fill(task)
  await expect(page.locator('.composer-intent button', { hasText: '新任务' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '发送并启动规划', exact: true }).click()
  await expect(page.locator('.message-stream').getByText(task, { exact: true })).toBeVisible()
  await expect(page.getByText('执行环境未就绪，规划尚未开始')).toBeVisible()
  await expect.poll(async () => (await operatorOverview(page)).missions.length).toBe(missionsBefore + 1)

  const pendingSubmissionKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('runguild:pending-submission:')))
  expect(pendingSubmissionKeys).toEqual([])

  const traceSummary = {
    runId: 'run_browser_acceptance', status: 'completed', attempt: 1, currentHop: 2, maxHops: 5,
    startedAt: '2026-09-14T06:00:00.000Z', finishedAt: '2026-09-14T06:00:03.000Z',
    createdAt: '2026-09-14T06:00:00.000Z',
    agent: { id: 'agent_browser', name: '浏览器验收 Agent', role: 'builder' },
    task: { id: 'task_browser', title: '验证运行详情响应', role: 'builder' },
    mission: { id: 'mission_browser', title: '浏览器验收 Mission' },
  }
  await page.route(/\/run-traces\?limit=20$/, async (route) => {
    await route.fulfill({ json: { runs: [traceSummary] } })
  })
  await page.route(/\/run-traces\/run_browser_acceptance$/, async (route) => {
    await route.fulfill({ json: { run: {
      ...traceSummary,
      modelProvider: 'test', modelName: 'browser-fixture',
      contextSummary: {
        modelProvider: 'test', modelName: 'browser-fixture', taskTitle: traceSummary.task.title,
        missionTitle: traceSummary.mission.title, tokenBudget: 4096, estimatedTokens: 512, compacted: false,
      },
      completionSummary: '浏览器已正确解包并展示 Run 详情',
      events: [], llmCalls: [], toolExecutions: [],
    } } })
  })

  for (const [hash, heading] of [
    ['#/artifacts', '活文档与冻结版本'],
    ['#/evaluation', '单 Agent 与协作团队对照'],
    ['#/trace', '项目运行账本'],
  ]) {
    await page.evaluate((nextHash) => { window.location.hash = nextHash }, hash)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await expect(page.getByText('浏览器已正确解包并展示 Run 详情')).toBeVisible()
})

test('/goal preserves its contract and zero budget through a lost atomic response and browser reload', async ({ page }) => {
  await openTeamRoom(page)
  const missionsBefore = (await operatorOverview(page)).missions.length
  const goal = `保留 Goal 契约与预算 ${Date.now()}`
  const attempts = []
  let committed
  await page.route(/\/task-submissions$/, async (route) => {
    attempts.push({ id: route.request().headers()['x-client-request-id'], body: route.request().postDataJSON() })
    const response = await route.fetch()
    expect(response.ok()).toBeTruthy()
    if (!committed) {
      committed = await response.json()
      // The transaction succeeds; only its browser response is lost.
      await route.abort('failed')
    } else {
      await route.fulfill({ response })
    }
  })

  await page.locator('.composer-field textarea').fill(`/goal ${goal}`)
  await page.getByLabel('验收条件（每行一项，可选）', { exact: true }).fill('可以预览错误行\n重复提交不重复创建目标')
  await page.getByLabel('约束（每行一项，可选）', { exact: true }).fill('保持已有接口兼容')
  await page.getByLabel('Token 总限额（可选）', { exact: true }).fill('0')
  await page.getByRole('button', { name: '创建目标并规划', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试待确认请求', exact: true })).toBeVisible()
  expect(attempts).toHaveLength(1)
  expect(committed.request.missionId).toBeTruthy()

  await page.reload()
  await selectDemoWorkspace(page)
  await expect.poll(async () => page.evaluate(() => Object.keys(window.localStorage)
    .filter((key) => key.startsWith('runguild:pending-submission:')).length)).toBe(0)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[0].body).toMatchObject({
    goal, constraints: ['保持已有接口兼容'], acceptanceCriteria: ['可以预览错误行', '重复提交不重复创建目标'],
    budgetTokens: 0, goalVerification: true, mentions: [],
  })
  expect(attempts[0].body).not.toHaveProperty('missionId')

  const missionResponse = await page.request.get(`/api/v1/workspaces/demo_workspace/missions/${committed.request.missionId}`)
  expect(missionResponse.ok()).toBeTruthy()
  expect(await missionResponse.json()).toMatchObject({
    goal, constraints: ['保持已有接口兼容'], acceptanceCriteria: ['可以预览错误行', '重复提交不重复创建目标'],
    goalVerification: true, budget: { tokenLimit: 0 },
  })
  expect((await operatorOverview(page)).missions.length).toBe(missionsBefore + 1)
  const messagesResponse = await page.request.get(messagesPath)
  expect(messagesResponse.ok()).toBeTruthy()
  expect((await messagesResponse.json()).messages.filter((message) => message.body === attempts[0].body.body)).toHaveLength(1)
})
