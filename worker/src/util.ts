import { MonitorTarget, WebhookConfig } from '../../types/config'
import { maintenances, workerConfig } from '../../uptime.config'

async function getWorkerLocation() {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace')
  const text = await res.text()

  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  return colo
}

const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const promise = fetch(url, { signal: controller.signal, ...options })
  if (signal) signal.addEventListener('abort', () => controller.abort())
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => clearTimeout(timeout))
}

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  const timeout = new Promise<T>((resolve, reject) =>
    setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  )

  return Promise.race([promise, timeout])
}

function formatStatusChangeNotification(
  monitor: any,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string,
  timeZone: string
) {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone,
  })

  let downtimeDuration = Math.round((timeNow - timeIncidentStart) / 60)
  const timeNowFormatted = dateFormatter.format(new Date(timeNow * 1000))
  const timeIncidentStartFormatted = dateFormatter.format(new Date(timeIncidentStart * 1000))

  if (isUp) {
    return `✅ [${monitor.name}] 恢复正常! \n该服务在宕机 ${downtimeDuration} 分钟后重新上线。`
  } else if (timeNow == timeIncidentStart) {
    return `🔴 [${
      monitor.name
    }] 目前宕机。 \n服务于 ${timeNowFormatted} 不可用。 \n原因: ${
      reason || '未说明'
    }`
  } else {
    return `🔴 [${
      monitor.name
    }] 依然宕机。 \n服务自 ${timeIncidentStartFormatted} 起不可用 (已持续 ${downtimeDuration} 分钟)。 \n原因: ${
      reason || '未说明'
    }`
  }
}

function templateWebhookPlayload(payload: any, message: string, env: any) {
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      if (typeof payload[key] === 'string') {
        payload[key] = payload[key].replace('$MSG', message)
        payload[key] = payload[key].replace(/\${env\.([a-zA-Z0-9_]+)}/g, (_: string, p1: string) => {
          return env[p1] || _
        })
      } else if (typeof payload[key] === 'object' && payload[key] !== null) {
        templateWebhookPlayload(payload[key], message, env)
      }
    }
  }
}

async function webhookNotify(env: any, webhook: WebhookConfig, message: string) {
  if (Array.isArray(webhook)) {
    for (const w of webhook) {
      webhookNotify(env, w, message)
    }
    return
  }

  console.log(
    'Sending webhook notification: ' + JSON.stringify(message) + ' to webhook ' + webhook.url
  )
  try {
    let url = webhook.url
    let method = webhook.method
    let headers = new Headers()
    
    if (webhook.headers) {
      for (const [k, v] of Object.entries(webhook.headers)) {
        let value = v.toString()
        value = value.replace(/\${env\.([a-zA-Z0-9_]+)}/g, (_: string, p1: string) => {
          const val = env[p1]
          if (!val) {
             console.log(`[Config Substitution] WARNING: Environment variable '${p1}' is missing or empty. Please check your Cloudflare Worker settings.`)
          }
          return val || _
        })
        headers.append(k, value)
      }
    }
    
    let payloadTemplated: { [key: string]: string | number } = JSON.parse(
      JSON.stringify(webhook.payload)
    )
    templateWebhookPlayload(payloadTemplated, message, env)
    let body = undefined

    switch (webhook.payloadType) {
      case 'param':
        method = method ?? 'GET'
        const urlTmp = new URL(url)
        for (const [k, v] of Object.entries(payloadTemplated)) {
          urlTmp.searchParams.append(k, v.toString())
        }
        url = urlTmp.toString()
        break
      case 'json':
        method = method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/json')
        }
        body = JSON.stringify(payloadTemplated)
        break
      case 'x-www-form-urlencoded':
        method = method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/x-www-form-urlencoded')
        }
        body = new URLSearchParams(payloadTemplated as any).toString()
        break
      default:
        throw 'Unrecognized payload type: ' + webhook.payloadType
    }

    console.log(
      `Webhook finalized parameters: ${method} ${url}, headers ${JSON.stringify(
        Object.fromEntries(headers.entries())
      )}, body ${JSON.stringify(body)}`
    )
    const resp = await fetchTimeout(url, webhook.timeout ?? 5000, { method, headers, body })

    if (!resp.ok) {
      console.log(
        'Error calling webhook server, code: ' + resp.status + ', response: ' + (await resp.text())
      )
    } else {
      console.log('Webhook notification sent successfully, code: ' + resp.status)
    }
  } catch (e) {
    console.log('Error calling webhook server: ' + e)
  }
}

// Auxiliary function to format notification and send it via webhook
const formatAndNotify = async (
  env: any,
  monitor: MonitorTarget,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string
) => {
  // Skip notification if monitor is in the skip list
  const skipList = workerConfig.notification?.skipNotificationIds
  if (skipList && skipList.includes(monitor.id)) {
    console.log(`Skipping notification for ${monitor.name} (${monitor.id} in skipNotificationIds)`)
    return
  }

  // Skip notification if monitor is in maintenance
  const maintenanceList = maintenances
    .filter(
      (m) =>
        new Date(timeNow * 1000) >= new Date(m.start) &&
        (!m.end || new Date(timeNow * 1000) <= new Date(m.end))
    )
    .map((e) => e.monitors || [])
    .flat()

  if (maintenanceList.includes(monitor.id)) {
    console.log(`Skipping notification for ${monitor.name} (in maintenance)`)
    return
  }

  if (workerConfig.notification?.webhook) {
    const notification = formatStatusChangeNotification(
      monitor,
      isUp,
      timeIncidentStart,
      timeNow,
      reason,
      workerConfig.notification?.timeZone ?? 'Etc/GMT'
    )
    await webhookNotify(env, workerConfig.notification.webhook, notification)
  } else {
    console.log(`Webhook not set, skipping notification for ${monitor.name}`)
  }
}

export {
  getWorkerLocation,
  fetchTimeout,
  withTimeout,
  webhookNotify,
  formatStatusChangeNotification,
  formatAndNotify,
}
