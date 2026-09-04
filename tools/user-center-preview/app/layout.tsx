import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '圈像创作｜用户中心与充值功能方案',
  description: '小程序用户中心、积分充值、余额与收支记录的独立方案预览。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
