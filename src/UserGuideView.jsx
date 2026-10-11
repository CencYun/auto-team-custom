import React from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, CircleHelp } from 'lucide-react';
import './user-guide.css';

const destinations = {
  teams: 'Team管理', free: 'Free账号管理', vault: '母号管理', mailbox: '邮箱管理',
  integrations: '参数配置', exports: '账号导出', history: '操作历史', settings: '设置',
};

const chapters = [
  ['start', '快速开始'], ['accounts', '导入与邀请'], ['authorization', '获取 Team JSON'],
  ['network', 'Roxy 与代理'], ['quota', '额度与导出'], ['storage', '资料存放'],
  ['automation', '自动化与删除'], ['faq', '常见问题'],
];

function GuideDetail({ title, children, open = false }) {
  return <details className="guide-detail" open={open}>
    <summary><span>{title}</span><ChevronDown size={16} aria-hidden="true" /></summary>
    <div className="guide-detail-body">{children}</div>
  </details>;
}

function GuideSection({ id, title, description, children }) {
  return <section className="guide-section" id={`guide-${id}`} aria-labelledby={`guide-title-${id}`}>
    <header><h2 id={`guide-title-${id}`}>{title}</h2>{description && <p>{description}</p>}</header>
    {children}
  </section>;
}

export default function UserGuideView({ onNavigate }) {
  function GoTo({ page, children }) {
    return <button type="button" className="guide-go" onClick={() => onNavigate?.(page)}>
      {children || `前往${destinations[page]}`}<ArrowUpRight size={14} aria-hidden="true" />
    </button>;
  }

  return <div className="user-guide">
    <div className="guide-intro">
      <span className="guide-intro-icon"><BookOpen size={23} aria-hidden="true" /></span>
      <div><h2>从导入账号到获取 Team JSON</h2><p>先完成一次邀请和授权，再按需要配置批量任务。下方可展开查看每一步。</p></div>
    </div>

    <nav className="guide-directory" aria-label="使用教程目录">
      {chapters.map(([id, title]) => <a key={id} href={`#guide-${id}`}>{title}</a>)}
    </nav>

    <GuideSection id="start" title="快速开始 · 推荐操作顺序" description="母号负责邀请，子号登录对应的 Team 工作空间，成功保存后才能查询该授权的额度。">
      <ol className="guide-steps">
        <li><span className="guide-step-number">1</span><h3>导入 Team</h3><p>在 Team管理中导入 Team 管理账号，确认工作空间和成员状态。</p><GoTo page="teams" /></li>
        <li><span className="guide-step-number">2</span><h3>导入子号</h3><p>在 Free账号管理中导入邮箱、密码和 2FA，核对账号资料。</p><GoTo page="free" /></li>
        <li><span className="guide-step-number">3</span><h3>邀请加入 Team</h3><p>回到对应 Team，选择子号发送邀请，确认邀请或成员状态。</p><GoTo page="teams" /></li>
        <li><span className="guide-step-number">4</span><h3>全自动获取 JSON</h3><p>在 Free账号管理选择对应 Team，运行授权并查看日志。</p><GoTo page="free" /></li>
        <li><span className="guide-step-number">5</span><h3>查询额度并导出</h3><p>确认 Team JSON 获取成功，再刷新额度或勾选需要的 JSON 导出。</p><GoTo page="exports" /></li>
      </ol>
      <p className="guide-note">「母号管理」和「邮箱管理」只存放资料。参与邀请、授权和轮转的账号，需要导入「Team管理」或「Free账号管理」。</p>
    </GuideSection>

    <GuideSection id="accounts" title="导入账号与邀请成员">
      <GuideDetail title="如何导入 Team 和 Free 账号？">
        <ol>
          <li>进入 Team管理，点击「导入账号」→「选择 Sub2API JSON」，选择包含 Team 授权的文件，再点「开始导入」。也可以用「添加 Team」手动填写页面要求的资料。</li>
          <li>JSON 混合文件会按账号类型分流：Team 记录合并到对应空间，Free 记录进入账号池。导入后检查工作空间、管理账号和成员信息；多个 Team 请分别核对。</li>
          <li>进入 Free账号管理，点击「导入账号」，选择「邮箱 / 密码 / 2FA」，一行粘贴一个账号。只添加一个账号时，也可使用「新增账号」。</li>
          <li>导入后查看列表。资料缺失或密码不正确时先编辑修正，再运行登录。</li>
        </ol>
        <pre className="guide-example"><code>{'member@example.com----示例密码----2FA密钥\nmember2@example.com----另一示例密码----另一2FA密钥'}</code></pre>
        <p>2FA 一般填写账号绑定的验证器密钥，由登录流程生成六位验证码；不要把某一时刻的六位验证码当作长期密钥保存。</p>
        <div className="guide-actions"><GoTo page="teams" /><GoTo page="free" /></div>
      </GuideDetail>
      <GuideDetail title="如何选择子号邀请？席位不足时怎么处理？">
        <ol>
          <li>在 Team管理选择目标 Team，点击「管理」→「邀请子号」，勾选要加入的子号，再点击「发送邀请」或「核验并发送邀请」。</li>
          <li>检查每个账号的返回结果。已发送邀请与已成为成员是不同状态，以同步后的成员信息为准。</li>
          <li>如果有空位但提示无法邀请，点击「刷新席位」，同步成员及待处理邀请；待接受邀请也可能占用可邀请名额。</li>
          <li>检查过期或不再需要的邀请，确认后点击「撤销邀请」，再重新选择账号邀请。已在 Team 的账号无需重复邀请。</li>
        </ol>
        <p>「补满席位」会按设置自动挑选候选账号补位。邀请模式不限邮箱域名，申请模式只选择与母号邮箱域名相同的账号。首次使用建议先手动邀请一个账号，确认完整流程能正常运行。</p>
        <GoTo page="teams" />
      </GuideDetail>
    </GuideSection>

    <GuideSection id="authorization" title="在 Free账号管理获取 Team JSON" description="浏览器授权从这里主动发起；检测额度不会自动打开浏览器登录。">
      <GuideDetail title="单个或批量全自动获取 JSON" open>
        <ol>
          <li>确认子号已收到邀请或已加入目标 Team，且邮箱、密码和 2FA 资料正确。</li>
          <li>在 Free账号管理顶部的「查看 / 授权 Team」中选择目标 Team。多个工作空间时，核对目标，避免使用个人空间授权。</li>
          <li>单个账号点击该行的「自动获取」；涉及多个 Team 时使用「选择 Team 获取」。批量处理点击「全自动获取 JSON」，按所选 Team 的待授权账号执行。</li>
          <li>打开运行日志查看进度：登录、验证、选择工作空间、处理回调、保存 JSON。只有最终显示成功，才表示此次授权已完成保存。</li>
          <li>成功后查看对应 Team 授权和额度；失败则先查看具体原因，修正资料或配置后，在运行日志勾选失败项重试，或使用单行「自动获取」。</li>
        </ol>
        <p>对应 Team 的 JSON 完整且授权有效时会跳过重复授权；过期或不完整的授权可以重新获取。批量任务中，一个账号完成或失败后会继续下一个；并发数决定同时运行几个账号。</p>
        <p className="guide-note">Free 表格里的勾选框用于删除选择，不控制批量授权。搜索和状态筛选也不缩小批量授权范围；只想跑一个账号时，请使用该行操作。</p>
        <p>全自动流程仍取决于账号状态、网络和登录验证。遇到需要人工完成的验证时，按运行日志提示处理。</p>
        <GoTo page="free" />
      </GuideDetail>
      <GuideDetail title="自动回调没有保存时，如何手动补交回调地址？">
        <ol>
          <li>在对应账号的手动授权入口发起授权，使用该次生成的登录链接完成登录和工作空间选择。</li>
          <li>登录完成后，从地址栏复制完整回调地址，保留地址后面的全部参数。</li>
          <li>回到同一个账号的手动回调输入框粘贴并提交，等待后台完成兑换和保存。</li>
        </ol>
        <p>回调地址必须与这次授权匹配。不要使用其他账号、已经过期或已使用的回调地址；也不要在等待回调时反复生成新授权链接。</p>
        <GoTo page="free" />
      </GuideDetail>
    </GuideSection>

    <GuideSection id="network" title="配置 Roxy 浏览器与代理" description="Roxy 是可选授权方式。未启用时走协议登录；启用并保存后，自动获取会使用 Roxy。">
      <GuideDetail title="首次配置 Roxy，建议从 1 个并发开始">
        <ol>
          <li>先启动本机 Roxy，确保 Local API 可用。在参数配置中填写 Local API 地址和 API Key。</li>
          <li>检查连接并选择 Roxy 工作空间。这里选择的是浏览器环境所属空间，和登录时选择的 Team 工作空间不同。</li>
          <li>选择「有头 · 实际打开浏览器」便于观察首次运行；稳定后可按需要切换无头模式。无头是否生效取决于 Roxy 版本和内核。</li>
          <li>设置浏览器并发数，默认 1，上限 3。1 个并发会逐个执行，3 个并发最多同时运行 3 个账号。</li>
          <li>启用 Roxy 并保存配置，再去 Free账号管理选一个账号测试。Free 页的并发设置与 Roxy 配置共用。</li>
        </ol>
        <GoTo page="integrations" />
      </GuideDetail>
      <GuideDetail title="只有 3 个 Roxy 环境时，如何避免名额被占满？">
        <p>账号环境模式可选择「一号一环境」或「复用环境」。套餐只允许保存 3 个环境时，建议使用「复用环境」，将最多授权环境数设为不超过可用名额。切换账号时会隔离登录会话。</p>
        <ul>
          <li>实际同时运行数量不超过并发数和可用环境数，剩余账号排队执行。</li>
          <li>开启「成功后释放环境名额」，JSON 核验保存后会关闭本次环境，并将本工具创建的环境移入 Roxy 回收站。</li>
          <li>开启「失败后释放环境名额」，失败或需要人工验证的任务结束后也会释放环境，账号资料和错误日志保留，可稍后重试。</li>
          <li>仅关闭窗口不一定减少 Roxy 的已保存环境用量。释放功能只清理本工具创建的环境，手动绑定的其他环境会保留；释放失败请查看日志提示。</li>
        </ul>
        <GoTo page="integrations" />
      </GuideDetail>
      <GuideDetail title="代理池和本机代理怎么配合？">
        <ol>
          <li>在参数配置的代理池中导入代理，确认协议、地址、端口和认证信息符合代理供应方要求，并保存设置。</li>
          <li>需要先经过本机代理连接上游时，启用「前置本机代理」并填写本机实际监听地址；对应客户端需已启动。请求会先经过本机代理，再连接代理池的上游，最后访问目标网站。</li>
          <li>需要 Roxy 使用代理池时，开启 Roxy 的代理池选项并保存。不要只导入代理，却漏掉启用和保存。</li>
          <li>先用一个账号观察运行日志，确认网络连接正常，再提高并发。</li>
        </ol>
        <p>代理连接失败时，一个账号最多尝试 3 条代理。密码错误、2FA 错误或人工验证等问题不会通过换代理解决；应先按日志修正对应问题。</p>
        <GoTo page="integrations" />
      </GuideDetail>
      <GuideDetail title="登录需要邮箱验证码时，如何配置取码？">
        <p>到参数配置中的「邮箱 / 接码」点击「配置」，选择接码方式，填写对应服务地址和密钥，启用集成后保存。账号单独填写的接码地址优先使用。</p>
        <p>自动取码取决于邮箱接口是否兼容；选择短信 API 不代表所有短信服务都已接通。此配置用于登录验证，不用于检测额度，也不能代替账号绑定的 2FA 密钥。</p>
        <GoTo page="integrations" />
      </GuideDetail>
    </GuideSection>

    <GuideSection id="quota" title="查看真实额度与导出 JSON">
      <GuideDetail title="额度如何刷新？为什么有时没有 5h / 7d？">
        <p>成功获取对应 Team JSON 后，在账号额度旁点击刷新，也可以使用批量刷新额度。Team管理的「检测额度」用于检查已有授权。</p>
        <ul>
          <li>额度依据服务端返回的实际窗口显示，例如 5h、7d 和重置时间；未返回的数据不会作为剩余额度展示。</li>
          <li>刷新只使用已有授权，必要时尝试已有刷新凭据，不会自动启动浏览器授权。</li>
          <li>缺少有效授权、授权已失效且无法刷新时，返回 Free账号管理，重新获取对应 Team JSON。</li>
          <li>查询失败或暂未获取到额度不代表额度为 0；先看错误提示，区分授权、网络或服务端状态。</li>
        </ul>
        <div className="guide-actions"><GoTo page="free" /><GoTo page="teams" /></div>
      </GuideDetail>
      <GuideDetail title="如何只导出需要的账号 JSON？">
        <ol>
          <li>进入账号导出，按账号 JSON、Team JSON 或所属 Team 筛选，也可以搜索邮箱。</li>
          <li>勾选已经成功获取、确实需要导出的记录，核对所属 Team 后点击导出。</li>
          <li>多个 Team 的授权请分别核对工作空间，避免把个人账号 JSON 当成目标 Team JSON 使用。</li>
        </ol>
        <p>这里导出的是授权 JSON。只需要「邮箱、密码、2FA」文本资料时，请使用母号管理或邮箱管理的 TXT 导出。</p>
        <GoTo page="exports" />
      </GuideDetail>
      <GuideDetail title="如何把已获取的授权推送到 Sub2API？">
        <ol>
          <li>进入参数配置，在 Sub2API 点击「管理」，填写连接名称、服务地址和 API Key / Token，并填写同步分组名称或有效的分组 ID。</li>
          <li>打开「启用此连接」，点击「保存连接」。分组名称需要准确匹配；已填写分组 ID 时优先按 ID 处理，未指定分组不能推送。</li>
          <li>有多个连接时，可用「新增 Sub2API」添加，再到 Team管理的「编辑 Team」中选择「目标 Sub2API」并保存。</li>
          <li>获取 Team JSON 后，在 Free账号管理选择具体 Team，点「更多」→「推送目标 Team 到 Sub2API」。个人 Free 授权则使用「推送 Free 到 Sub2API」。</li>
          <li>查看推送结果和操作历史，核对成功、跳过及失败数量。已有的相同邮箱与空间记录通常会跳过，失败时按提示检查连接、分组或授权。</li>
        </ol>
        <p>推送范围不受 Free 表格的删除勾选控制；需要自己挑选记录下载文件时，使用「账号导出」。</p>
        <div className="guide-actions"><GoTo page="integrations" /><GoTo page="free" /></div>
      </GuideDetail>
    </GuideSection>

    <GuideSection id="storage" title="独立存放母号与邮箱资料" description="这两个页面用于资料整理。导入这里不会自动邀请、登录、获取 JSON 或参与轮转。">
      <GuideDetail title="母号管理：保存资料、编辑日期和排序">
        <p>导入账号、密码、2FA 和备注时间后，可在列表查看、编辑、勾选导出或删除。凭据默认显示，点击眼睛可隐藏，再次点击恢复显示。</p>
        <p>备注时间支持自动填入今天，也可以继续手动修改。点击「备注时间」旁的箭头切换日期升序或降序；母号记录会跟随日期重新排序，空日期或无法识别的日期排在最后。</p>
        <p>需要文本文件时选择 TXT 导出。资料存放和 Team管理中的运行账号互相独立。</p>
        <GoTo page="vault" />
      </GuideDetail>
      <GuideDetail title="邮箱管理：批量导入、复制登录凭据与 TXT 导出">
        <ol>
          <li>打开导入窗口，一行填写一个邮箱的账号、密码和 2FA，批量导入后检查拆分结果。</li>
          <li>勾选邮箱并点击「复制登录凭据」，会按下面的格式复制，多条账号各占一行。</li>
          <li>需要文件时点击「导出已选 TXT」。导出的邮箱会显示红色「已使用」，仍然可以再次导出。</li>
        </ol>
        <pre className="guide-example"><code>member@example.com----示例密码----2FA密钥</code></pre>
        <p>「复制登录凭据」不会标记已使用。已使用标记只作用于实际导出的邮箱；未勾选的邮箱不会因为本次导出而改变。</p>
        <GoTo page="mailbox" />
      </GuideDetail>
    </GuideSection>

    <GuideSection id="automation" title="自动化、移除成员与删除账号">
      <GuideDetail title="「自动化开启」怎么用？">
        <p>用于按设置周期检测 Team、移除符合条件的成员并补满席位。开启后会实际执行邀请和移除操作，请先确认要参与轮转的 Team 与候选账号。</p>
        <ol>
          <li>准备账号：在 Team管理中导入有效的母号管理授权，在 Free账号管理中导入候选账号，先验证一次邀请和获取 Team JSON 的流程。</li>
          <li>配置规则：进入「设置」，检查「加入 Team 方式」「自动踢出条件」「额度耗尽后延迟踢出」「检测周期」和「全局并发数」，再点击「保存设置」。使用 Roxy 时，在参数配置中另设浏览器并发数（1–3）。</li>
          <li>确认轮转范围：在 Team管理中检查「参与自动轮转」、固定主号和每日轮转上限。额度预警阈值只用于标记低额度，不表示达到阈值就立即移除。</li>
          <li>开启运行：点击页面顶部的「自动化开启」。状态变为 Live、按钮变为「暂停」，表示自动化已开启，会安排一次维护并继续按周期运行。</li>
          <li>查看结果：在首页查看进度，到「操作历史」查看检测、邀请、补位和失败原因。缺少候选账号或授权失败时，根据日志补充账号或修正配置。</li>
          <li>暂停运行：点击顶部「暂停」，状态变为 Paused，停止安排后续自动维护。已经开始的任务可能继续完成，可在操作历史中确认结果。</li>
        </ol>
        <p>设置里的「自动补满席位」与顶部按钮控制同一个开关。打开该选项并保存，也会启用自动化；如果已显示 Live，无需再点顶部按钮。</p>
        <p>自动化默认关闭。开启后，补位和候选池准备可能按协议或 Roxy 配置获取授权。手动「检测额度」只查询已有授权的额度，不会开启自动化或启动浏览器；需要单独获取 JSON 时，到 Free账号管理操作。</p>
        <div className="guide-actions"><GoTo page="settings" /><GoTo page="history" /></div>
      </GuideDetail>
      <GuideDetail title="如何移除成员，再删除本地账号？">
        <ol>
          <li>仍在 Team 成员列表中的账号不能直接删除。先在 Free账号管理选择正确 Team，使用单个或批量「移除成员」。</li>
          <li>核对要移除的账号和 Team，完成页面要求的确认，再提交。</li>
          <li>等待移除成功和成员状态更新。若账号还在其他 Team 中，需要先从所有 Team 移除，再勾选删除本地账号。</li>
        </ol>
        <p>允许删除未授权 Free、已封禁或已经踢出的账号，但母号和仍在 Team 成员列表中的账号会受到保护。账号导出页的批量删除也遵守成员保护规则，而且会删除该本地账号及其全部 JSON，不只是所选的某条授权。</p>
        <p>母号管理和邮箱管理中的删除只处理各自的资料记录。操作前核对当前页面，避免把资料仓库与运行账号混淆。</p>
        <GoTo page="free" />
      </GuideDetail>
    </GuideSection>

    <GuideSection id="faq" title="常见问题" description="先看具体任务的运行日志；跨账号或历史操作可到操作历史查看。">
      <GuideDetail title="邀请成功了，为什么仍然拿不到 Team JSON？">
        <p>邀请成功只表示邀请已发送。检查账号是否进入对应 Team、选择的工作空间是否正确，再确认密码和 2FA。遇到工作空间不可用时，先同步成员与邀请状态，确认目标 Team 后再重试。</p>
      </GuideDetail>
      <GuideDetail title="出现 403 或连接超时，一定是代理池问题吗？">
        <p>不一定。超时可能来自代理连接或目标网络；403 表示请求被拒绝，也可能与授权状态或访问限制有关。先查看日志在哪一步失败，再检查代理协议、连通性和账号状态，不要只凭状态码反复换代理。</p>
      </GuideDetail>
      <GuideDetail title="浏览器一打开就关闭，是不是没有运行？">
        <p>查看同一次任务的最终日志。启动失败、登录失败或授权成功都可能进入关闭和释放流程；窗口关闭本身不能代表授权成功。以 JSON 保存结果和错误信息为准。</p>
      </GuideDetail>
      <GuideDetail title="获取成功的账号会再跑一遍吗？失败账号怎么重试？">
        <p>批量获取会跳过对应 Team 已完整保存且仍有效的 JSON。失败后先修正日志指出的问题，再在运行日志勾选失败项重试，或使用该账号的单行自动获取；Free 表格里的删除勾选不控制授权范围。</p>
      </GuideDetail>
      <GuideDetail title="导入邮箱管理后，为什么 Free账号管理里没有出现？">
        <p>邮箱管理是独立资料仓库。如果要用这些邮箱邀请和授权，可先勾选复制登录凭据或导出 TXT，再到 Free账号管理导入。</p>
      </GuideDetail>
      <div className="guide-help-foot"><CircleHelp size={17} aria-hidden="true" /><span>定位问题时，记录账号、所选 Team 和错误阶段，避免只根据窗口是否打开判断结果。</span><GoTo page="history" /></div>
    </GuideSection>
  </div>;
}
