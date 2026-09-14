import { expect, test } from '@playwright/test'

const overviewPath = '/api/v1/workspaces/demo_workspace/projects/demo_project/operator-overview'
const messagesPath = '/api/v1/workspaces/demo_workspace/conversations/demo_project%3Aconversation%3Ateam/messages'

async function openTeamRoom(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '选择一个 Agent 团队开始工作' })).toBeVisible()
  await page.locator('.workspace-card__open', { hasText: 'RunGuild 演示项目' }).click()
  await expect(page.getByRole('heading', { name: '和 Agent 团队一起工作' })).toBeVisible()
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
  await page.getByRole('button', { name: '发送普通消息' }).click()
  await expect(page.getByText(greeting, { exact: true })).toBeVisible()
  expect((await operatorOverview(page)).missions.length).toBe(missionsBefore)

  const messagesResponse = await page.request.get(messagesPath)
  expect(messagesResponse.ok()).toBeTruthy()
  const greetingRecord = (await messagesResponse.json()).messages.find((message) => message.body === greeting)
  expect(greetingRecord).toBeTruthy()
  expect(greetingRecord.entityRefs.missionId).toBeUndefined()

  const task = `帮我创建浏览器验收页面 ${Date.now()}`
  await composer.fill(task)
  await expect(page.locator('.composer-intent button', { hasText: '新任务' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '发送并启动规划' }).click()
  await expect(page.getByText(task, { exact: true })).toBeVisible()
  await expect(page.getByText('执行环境未就绪，规划尚未开始')).toBeVisible()
  await expect.poll(async () => (await operatorOverview(page)).missions.length).toBe(missionsBefore + 1)

  const pendingSubmissionKeys = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('runguild:pending-submission:')))
  expect(pendingSubmissionKeys).toEqual([])
})
