'use client';

import {
  AlertTriangle, ArrowRight, BadgeCheck, Banknote, Check,
  ChevronRight, Clock3, Cloud, Code2, CreditCard, Database, FileCheck2,
  Fingerprint, LockKeyhole, ReceiptText, RefreshCw, Route, ShieldCheck,
  Smartphone, ToggleRight, UserRound, WalletCards, X, Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type PhoneView = 'entry' | 'center' | 'recharge' | 'records';
type PayState = 'hidden' | 'disabled' | 'enabled';

const phoneViewHashes: Record<PhoneView, string> = {
  entry: '#decision',
  center: '#user-center',
  recharge: '#recharge',
  records: '#records',
};

function phoneViewFromHash(hash: string): PhoneView | null {
  const entry = Object.entries(phoneViewHashes).find(([, value]) => value === hash);
  return entry ? entry[0] as PhoneView : null;
}

const packages = [
  { price: '¥9.9', points: '100', tag: '轻量体验' },
  { price: '¥29.9', points: '330', tag: '多送 30', featured: true },
  { price: '¥59.9', points: '688', tag: '多送 88' },
];

const transactions = [
  { kind: '充值', title: '330 积分套餐', time: '2026-09-01 14:26', amount: '+330', balance: '128.5', tone: 'positive' },
  { kind: '消费', title: '图片创作', time: '2026-09-01 13:08', amount: '-10', balance: '118.5', tone: 'negative' },
  { kind: '退款', title: '视频生成失败退回', time: '2026-08-31 21:42', amount: '+10', balance: '128.5', tone: 'positive' },
  { kind: '奖励', title: '每日签到', time: '2026-08-31 09:15', amount: '+0.5', balance: '118.5', tone: 'positive' },
  { kind: '变动', title: '积分变动', time: '2026-08-30 08:00', amount: '+0.1', balance: '118.6', tone: 'neutral' },
];

const recordFilters = ['全部', '充值', '消费', '奖励', '退款'];

function payStateFromSearch(search: string): PayState {
  const value = new URLSearchParams(search).get('payState');
  return value === 'hidden' || value === 'enabled' ? value : 'disabled';
}

const flowSteps = [
  { icon: Smartphone, title: '选套餐与通道', text: '小程序只提交套餐 ID、通道和请求号。' },
  { icon: Cloud, title: '云端创建订单', text: '服务端锁定金额与积分，前端无法改价。' },
  { icon: CreditCard, title: '拉起微信支付', text: '只接受服务端返回的微信支付参数。' },
  { icon: ShieldCheck, title: '验签并查单', text: '回调验签后再主动查单，双重确认。' },
  { icon: Database, title: '事务入账', text: '订单、流水、余额一次提交，重复回调只记一次。' },
];

const launchChecks = [
  '微信支付完成真机支付闭环',
  '微信商户提供正式 AppID、版本、路径和参数说明',
  '旧密码、API 密钥和 RSA 密钥全部轮换',
  '重复回调、金额篡改、超时补单测试全部通过',
  '充值开关默认关闭，内测通过后按通道单独开启',
];

const nav = [
  { href: '#decision', label: '方案结论' }, { href: '#preview', label: '页面预览' },
  { href: '#payment', label: '支付闭环' }, { href: '#data', label: '接口与数据' },
  { href: '#launch', label: '上线门槛' },
];

function SectionTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="section-title-block"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{description}</p></div>;
}

function PhoneMockup({ view, setView, payState, captureMode }: { view: PhoneView; setView: (value: PhoneView) => void; payState: PayState; captureMode: boolean }) {
  const [selectedPackage, setSelectedPackage] = useState(1);
  const [recordFilter, setRecordFilter] = useState('全部');
  return (
    <div className="phone-stage">
      <div className={`phone-shell${captureMode ? ' g1-capture-shell' : ''}`} aria-label="小程序方案手机预览">
        <div className="phone-sensor" /><div className="phone-status"><span>9:41</span><span>● ● ◒</span></div>
        <div className="phone-screen" data-g1-root data-g1-page={view} data-g1-pay-state={payState}>
          {view === 'entry' && <div className="mini-page">
            <div className="mini-hero">
              <div className="mini-brand-row"><div className="mini-logo">圈</div><div className="mini-brand-copy"><strong>圈像创作</strong><span>圈定想改的，创作想要的。</span></div>
                <button className="avatar-entry" onClick={() => setView('center')} aria-label="打开用户中心"><UserRound size={18} /><span className="entry-marker">我的</span></button>
              </div>
              <div className="mini-welcome"><strong>今天，想创作什么？</strong><span>先选入口，后面按需补素材。</span></div><span className="orbit orbit-red" /><span className="orbit orbit-blue" />
            </div>
            <div className="mini-points-card"><div><span>我的积分</span><strong>128.5 积分</strong><small>连续签到 3 天 · 今日已签到</small></div><button>已签到</button></div>
            <div className="mini-section-label"><i />常用功能</div>
            {['开始新创作', '制作记录', '照片转实况图'].map((item, index) => <div className="mini-list-card" key={item}>
              <span className={`mini-icon tone-${index}`}>{index === 0 ? '创' : index === 1 ? '记' : '动'}</span>
              <div><strong>{item}</strong><small>{index === 0 ? '选择区域并描述想要的效果' : index === 1 ? '查看之前完成的作品' : '把照片制作成动态内容'}</small></div><ChevronRight size={17} />
            </div>)}
            <div className="mini-note"><Check size={13} />右上角替换重复的“云端已连接”，底部状态继续保留</div>
          </div>}

          {view === 'center' && <div className="mini-page">
            <div className="profile-card"><div className="profile-avatar"><UserRound size={25} /></div><div><strong>微信用户</strong><span>完善头像与昵称</span></div><ChevronRight size={17} /></div>
            <div className="balance-card"><span>当前积分</span><div className="balance-line"><strong>128.5</strong><small>积分</small></div><p>图片与视频创作统一使用积分</p>{payState !== 'hidden' && <button data-g1-cta data-g1-cta-state={payState} disabled={payState === 'disabled'} onClick={() => setView('recharge')}>{payState === 'disabled' ? '通道准备中' : <>立即充值 <ArrowRight size={15} /></>}</button>}</div>
            <div className={`quick-grid${payState === 'hidden' ? ' single' : ''}`}>{payState !== 'hidden' && <button onClick={() => setView('recharge')}><WalletCards size={20} /><strong>积分充值</strong><span>固定套餐</span></button>}<button onClick={() => setView('records')}><ReceiptText size={20} /><strong>收支记录</strong><span>充值与消费</span></button></div>
            <div className="account-panel"><div className="panel-head"><strong>最近记录</strong><button onClick={() => setView('records')}>全部 <ChevronRight size={14} /></button></div>
              {transactions.slice(0, 3).map(item => <div className="transaction-row" key={item.title}><span className={`transaction-icon ${item.tone}`}>{item.kind.slice(0, 1)}</span><div><strong>{item.title}</strong><small>{item.time}</small></div><b className={item.tone}>{item.amount}</b></div>)}
            </div><div className="mini-note"><BadgeCheck size={13} />未完善资料也能充值，身份仍使用微信 OpenID</div>
          </div>}

          {view === 'recharge' && <div className="mini-page">
            <div className="recharge-balance"><span>本次预计到账</span><strong>+{packages[selectedPackage].points} <small>积分</small></strong></div>
            <div className="mini-block-title">选择充值套餐</div><div className="package-grid">
              {packages.map((item, index) => <button className={selectedPackage === index ? 'selected' : ''} key={item.price} onClick={() => setSelectedPackage(index)}>{item.featured && <em>推荐</em>}<strong>{item.points}</strong><span>积分</span><b>{item.price}</b><small>{item.tag}</small></button>)}
            </div>
            <div className="mini-block-title">支付方式 <small>仅支持微信支付</small></div><div className="channel-list">
              <button className="selected" disabled={payState !== 'enabled'}><span className="channel-logo wx">微</span><div><strong>微信支付</strong><small>{payState === 'enabled' ? '当前可用' : payState === 'disabled' ? '通道准备中' : '暂未开放'}</small></div><i><Check size={12} /></i></button>
            </div>{payState !== 'hidden' && <button className="pay-button" data-g1-cta data-g1-cta-state={payState} disabled={payState === 'disabled'}>{payState === 'disabled' ? '通道准备中' : <>确认支付 {packages[selectedPackage].price}</>}</button>}{payState === 'hidden' && <div className="pay-unavailable">充值暂未开放</div>}<p className="payment-hint"><LockKeyhole size={13} />支付完成后由服务端确认到账，不由前端直接加积分</p>
          </div>}

          {view === 'records' && <div className="mini-page">
            <div className="record-summary"><span>当前积分</span><strong>128.5</strong><small>累计充值 330 积分</small></div><div className="record-tabs">{recordFilters.map(item => <button className={recordFilter === item ? 'active' : ''} onClick={() => setRecordFilter(item)} key={item}>{item}</button>)}</div>
            <div className="account-panel records-panel">{transactions.filter(item => recordFilter === '全部' || item.kind === recordFilter).map(item => <div className="transaction-row" key={item.title}><span className={`transaction-icon ${item.tone}`}>{item.kind.slice(0, 1)}</span><div><strong>{item.title}</strong><small>{item.time} · 余额 {item.balance}</small></div><b className={item.tone}>{item.amount}</b></div>)}</div><p className="record-foot">仅展示已由服务端确认的流水</p>
          </div>}
        </div><div className="phone-home-bar" />
      </div>
      <fieldset className="view-switch" aria-label="切换手机预览">{[['entry', '入口位置'], ['center', '用户中心'], ['recharge', '充值页'], ['records', '记录页']].map(([value, label]) => <button className={view === value ? 'active' : ''} onClick={() => setView(value as PhoneView)} key={value}>{label}</button>)}</fieldset>
    </div>
  );
}

export default function Home() {
  const [phoneView, setPhoneView] = useState<PhoneView>('entry');
  const [payState, setPayState] = useState<PayState>('disabled');
  const [captureMode, setCaptureMode] = useState(false);

  const navigatePhoneView = useCallback((nextView: PhoneView, replace = false) => {
    setPhoneView(nextView);
    if (typeof window === 'undefined') return;

    const nextHash = phoneViewHashes[nextView];
    if (window.location.hash !== nextHash) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', nextHash);
    }
    window.requestAnimationFrame(() => {
      document.getElementById('decision')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  useEffect(() => {
    const syncPhoneViewFromUrl = () => {
      const nextView = phoneViewFromHash(window.location.hash);
      if (nextView) setPhoneView(nextView);
      setPayState(payStateFromSearch(window.location.search));
      setCaptureMode(new URLSearchParams(window.location.search).get('capture') === '1');
    };

    syncPhoneViewFromUrl();
    window.addEventListener('hashchange', syncPhoneViewFromUrl);
    window.addEventListener('popstate', syncPhoneViewFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncPhoneViewFromUrl);
      window.removeEventListener('popstate', syncPhoneViewFromUrl);
    };
  }, []);

  return <main>
    <header className="topbar"><a className="brand" href="#decision"><span>圈</span><div><strong>圈像创作</strong><small>用户账户与充值功能方案</small></div></a><nav aria-label="方案章节">{nav.map(item => <a href={item.href} key={item.href}>{item.label}</a>)}</nav><div className="review-state"><span /><strong>待你确认</strong></div></header>
    <div className="page-shell">
      <section className="decision-section" id="decision"><div className="decision-copy"><div className="status-strip"><FileCheck2 size={15} />方案预览 · 小程序源码未修改</div><h1>用户中心放在工作台右上角，<br />充值沿用现有积分账户。</h1><p className="lead">不加底部导航，不拆掉现有积分页。新增一个聚合入口，让用户能看余额、购买积分、查充值和消费记录。</p>
        <div className="decision-grid"><div><UserRound size={19} /><span><strong>入口</strong>工作台右上角头像</span></div><div><WalletCards size={19} /><span><strong>账户</strong>现有积分余额</span></div><div><CreditCard size={19} /><span><strong>支付</strong>微信支付闭环</span></div><div><ToggleRight size={19} /><span><strong>上线</strong>微信通道验收后开启</span></div></div>
        <div className="locked-box"><div className="locked-head"><LockKeyhole size={17} /><strong>已经锁定的业务参数</strong></div><div className="package-line">{packages.map(item => <span key={item.price}><b>{item.price}</b> = {item.points} 积分</span>)}</div></div>
      </div><PhoneMockup view={phoneView} setView={navigatePhoneView} payState={payState} captureMode={captureMode} /></section>

      <section className="content-section" id="preview"><SectionTitle eyebrow="页面落点" title="只增加一个用户中心，现有功能继续各司其职" description="入口不抢工作台主流程；用户中心负责聚合，签到与积分规则仍留在原积分页。" />
        <div className="placement-grid">
          <article className="placement-card recommended"><div className="card-number">01</div><BadgeCheck size={23} /><h3>工作台右上角头像</h3><p>替换顶部重复的云端状态，点击进入用户中心。底部仍保留“云端已连接”。</p><span className="card-tag">推荐落点</span></article>
          <article className="placement-card"><div className="card-number">02</div><UserRound size={23} /><h3>独立用户中心</h3><p>集中展示资料、余额、充值入口和最近流水，资料未完善也不阻塞充值。</p><span className="card-tag neutral">新增页面</span></article>
          <article className="placement-card"><div className="card-number">03</div><ReceiptText size={23} /><h3>复用积分流水</h3><p>充值写入现有积分账本，统一筛选充值、消费、退款，避免两套余额。</p><span className="card-tag neutral">复用能力</span></article>
        </div>
        <div className="impact-map"><div className="impact-label"><Route size={20} /><strong>预计代码落点</strong><span>确认后才会修改</span></div><div className="impact-flow"><span><b>现有</b> pages/workbench</span><ArrowRight size={17} /><span><b>新增</b> pages/user-center</span><ArrowRight size={17} /><span><b>新增</b> cloudfunctions/payment</span></div><div className="impact-note">资料页改为原路返回；积分页保留签到和积分规则；不新增 TabBar。</div></div>
      </section>

      <section className="content-section" id="payment"><SectionTitle eyebrow="支付闭环" title="支付成功不等于积分到账，服务端确认后才入账" description="星聚负责创建支付，小程序只负责拉起；验签、查单、幂等和补单全部留在云端。" />
        <div className="flow-board">{flowSteps.map((step, index) => { const Icon = step.icon; return <div className="flow-item" key={step.title}><div className="flow-icon"><Icon size={21} /></div><div className="flow-index">0{index + 1}</div><h3>{step.title}</h3><p>{step.text}</p>{index < flowSteps.length - 1 && <ArrowRight className="flow-arrow" size={18} />}</div>; })}</div>
        <div className="payment-decisions"><article><ToggleRight size={22} /><div><strong>微信通道独立开关</strong><p>只有微信通道返回可用状态后才显示可支付操作。</p></div></article><article><RefreshCw size={22} /><div><strong>回调 + 主动查单 + 定时补单</strong><p>回调丢失或入账暂时失败时，云端继续查单补齐，用户不用重复付款。</p></div></article><article><AlertTriangle size={22} /><div><strong>微信商户资料是硬门槛</strong><p>商户号、签名材料和回调配置不完整时，通道保持关闭。</p></div></article></div>
      </section>

      <section className="content-section" id="data"><SectionTitle eyebrow="接口与数据" title="新增支付域，复用用户、余额和积分流水" description="支付订单单独保存，到账后仍写入现有积分账户，用户看到的余额始终只有一个。" />
        <div className="data-grid"><div className="api-panel"><div className="panel-title"><Code2 size={20} /><div><strong>小程序调用接口</strong><span>均通过云函数，不直连星聚</span></div></div>{[['getRechargeConfig', '读取套餐和当前可用通道'], ['createRechargeOrder', '创建或复用同一笔订单'], ['queryRechargeOrder', '查单并尝试完成积分入账'], ['getAccountLedger', '分页读取充值、消费和退款记录']].map(([name, desc]) => <div className="api-row" key={name}><code>{name}()</code><span>{desc}</span></div>)}</div>
          <div className="model-panel"><div className="panel-title"><Database size={20} /><div><strong>数据写入关系</strong><span>事务内一次完成</span></div></div><div className="model-stack"><div><span>payment_orders</span><small>订单号、套餐快照、金额、通道、支付状态</small></div><ArrowRight size={18} /><div><span>point_ledger</span><small>新增 recharge 流水，订单号作为幂等键</small></div><ArrowRight size={18} /><div><span>user_accounts</span><small>增加积分余额与累计充值积分</small></div></div></div></div>
        <div className="security-grid">{[[Fingerprint, 'V2 RSA', '只使用 RSA 签名，旧 MD5 兼容模式关闭。'], [Banknote, '整数分金额', '套餐金额由服务端映射，客户端传价无效。'], [ShieldCheck, '双重确认', '验回调签名后还要主动查询平台订单。'], [Zap, '严格幂等', '重复回调和并发查单只能增加一次积分。'], [LockKeyhole, '密钥不上前端', '商户私钥、公钥和开关放云端配置。'], [Clock3, '异常待复核', '金额不符、冻结或状态冲突时不自动入账。']].map(([Icon, title, text]) => { const SecurityIcon = Icon as typeof ShieldCheck; return <article key={String(title)}><SecurityIcon size={20} /><div><strong>{String(title)}</strong><p>{String(text)}</p></div></article>; })}</div>
      </section>

      <section className="content-section launch-section" id="launch"><SectionTitle eyebrow="上线门槛" title="先关着开关完成微信真机闭环" description="接口能下单不代表可上线；必须从小程序拉起、支付、回调、查单到积分到账全部跑通。" />
        <div className="launch-layout"><div className="checklist-card"><div className="checklist-head"><FileCheck2 size={22} /><div><strong>首发验收清单</strong><span>全部满足后才打开充值总开关</span></div></div>{launchChecks.map(item => <div className="check-row" key={item}><span><Check size={14} /></span><p>{item}</p></div>)}</div>
          <div className="scope-card"><div className="scope-head"><X size={20} /><strong>本次明确不做</strong></div><div className="scope-tags">{['会员等级', '到期续费', '提现', '优惠券', '推荐返利', '用户自助退款', '新管理后台', '手机号登录'].map(item => <span key={item}>{item}</span>)}</div><div className="risk-note"><AlertTriangle size={18} /><p><strong>第三方支付风险控制</strong>当前微信通道未验证可用；未通过真机测试的通道保持隐藏。已经暴露过的登录密码和密钥必须先轮换。</p></div></div></div>
        <div className="final-decision"><BadgeCheck size={25} /><div><strong>建议按这版落地</strong><span>入口清晰、复用现有积分体系、支付风险可随时通过后台开关隔离。</span></div><span className="final-state">等待确认后修改源码</span></div>
      </section>
    </div>
    <footer><span>圈像创作 · 用户中心与充值功能方案</span><span>独立预览文件，不属于小程序源码</span></footer>
  </main>;
}
