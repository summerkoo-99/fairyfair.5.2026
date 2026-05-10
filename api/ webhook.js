// api/webhook.js
// 슬랙 이벤트 수신 → 슬랙 API로 전체 데이터 수집 → HTML 재생성 → GitHub 커밋

import crypto from 'crypto'
import { Octokit } from '@octokit/rest'

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN
const GITHUB_OWNER         = process.env.GITHUB_OWNER   // 예: 'jian'
const GITHUB_REPO          = process.env.GITHUB_REPO    // 예: 'jidokpat'
const CHANNEL_ID           = process.env.SLACK_CHANNEL_ID // C0AUPS7B97A

// ── 슬랙 서명 검증 ──────────────────────────────────────────
function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']
  if (!timestamp || !signature) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
  const computed = 'v0=' + hmac.update(baseString).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
}

// ── 슬랙 API 호출 ────────────────────────────────────────────
async function slackAPI(method, params = {}) {
  const url = `https://slack.com/api/${method}`
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${url}?${qs}`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  })
  return res.json()
}

// ── 채널 메시지 + 스레드 전체 수집 ──────────────────────────
async function fetchAllData() {
  const messages = []
  let cursor = undefined

  // 채널 메시지 페이지네이션
  while (true) {
    const params = { channel: CHANNEL_ID, limit: 200 }
    if (cursor) params.cursor = cursor
    const res = await slackAPI('conversations.history', params)
    if (!res.ok) break
    messages.push(...res.messages)
    if (!res.response_metadata?.next_cursor) break
    cursor = res.response_metadata.next_cursor
  }

  // 스레드가 있는 메시지만 replies 수집
  const threads = []
  for (const msg of messages) {
    if (!msg.thread_ts || msg.reply_count === 0) continue
    const res = await slackAPI('conversations.replies', {
      channel: CHANNEL_ID,
      ts: msg.thread_ts,
      limit: 200
    })
    if (res.ok) {
      threads.push({
        parent: res.messages[0],
        replies: res.messages.slice(1)
      })
    }
  }

  return { messages, threads }
}

// ── HTML 템플릿 생성 (현재 jidokpat_mobile.html 기반) ────────
async function buildHTML(data) {
  // GitHub에서 현재 템플릿 HTML 가져오기
  const octokit = new Octokit({ auth: GITHUB_TOKEN })
  const { data: fileData } = await octokit.repos.getContent({
    owner: GITHUB_OWNER,
    repo:  GITHUB_REPO,
    path:  'template.html'  // 템플릿 파일 (데이터 없는 버전)
  })
  const template = Buffer.from(fileData.content, 'base64').toString('utf-8')

  // 슬랙 데이터를 KKOJIL 형식으로 변환
  const kkojil = data.threads.map(thread => ({
    q:      thread.parent.text,
    sender: '지안',
    ans:    thread.replies.map(r => ({
      who: r.user_profile?.display_name || r.username || r.user,
      t:   r.text
    }))
  }))

  const kkojilJson = JSON.stringify(kkojil, null, 0)

  // 템플릿의 KKOJIL 데이터 교체
  const newHtml = template.replace(
    /const KKOJIL=\[.*?\];/s,
    `const KKOJIL=${kkojilJson};`
  )
  return newHtml
}

// ── GitHub에 HTML 커밋 → Vercel 자동 재배포 트리거 ──────────
async function commitToGitHub(html) {
  const octokit = new Octokit({ auth: GITHUB_TOKEN })

  // 현재 파일 SHA 가져오기
  let sha
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      path:  'index.html'
    })
    sha = data.sha
  } catch (e) {
    // 파일 없으면 새로 생성
  }

  const content = Buffer.from(html).toString('base64')
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

  await octokit.repos.createOrUpdateFileContents({
    owner:   GITHUB_OWNER,
    repo:    GITHUB_REPO,
    path:    'index.html',
    message: `[auto] 슬랙 데이터 업데이트 ${now}`,
    content,
    ...(sha ? { sha } : {})
  })
}

// ── 메인 핸들러 ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = JSON.stringify(req.body)

  // 슬랙 URL 검증 (최초 1회)
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge })
  }

  // 서명 검증
  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // 메시지 이벤트만 처리
  const event = req.body.event
  if (!event || !['message', 'message.replied'].includes(event.type)) {
    return res.status(200).end()
  }

  // 해당 채널 메시지만
  if (event.channel !== CHANNEL_ID) return res.status(200).end()

  // 즉시 200 응답 (슬랙은 3초 내 응답 요구)
  res.status(200).json({ ok: true })

  // 비동기로 데이터 수집 + HTML 재생성 + 배포
  try {
    console.log('[jidokpat] 슬랙 이벤트 수신 — 데이터 수집 시작')
    const data = await fetchAllData()
    console.log(`[jidokpat] 스레드 ${data.threads.length}개 수집 완료`)
    const html = await buildHTML(data)
    await commitToGitHub(html)
    console.log('[jidokpat] GitHub 커밋 완료 → Vercel 재배포 시작')
  } catch (err) {
    console.error('[jidokpat] 오류:', err)
  }
}
