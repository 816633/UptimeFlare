import { Divider } from '@mantine/core'
import { pageConfig } from '@/uptime.config'

export default function Footer() {
  const defaultFooter =
    '<p style="text-align: center; font-size: 12px; margin-top: 10px;">由 <a href="https://github.com/lyc8503/UptimeFlare" target="_blank">Uptimeflare</a> 提供支持的开源监控和状态页面,作者是 <a href="https://github.com/lyc8503" target="_blank">lyc8503</a> </p>'

  return (
    <>
      <Divider mt="lg" />
      <div dangerouslySetInnerHTML={{ __html: pageConfig.customFooter ?? defaultFooter }} />
    </>
  )
}
