import React from 'react';

/*
 * Placeholder screen content: a light-mode WhatsApp-like chat in screen pixels (1179 x 2556), with an iOS status bar.
 * The header deliberately shows a sandbox-style number and a grey avatar, so the HeaderCover patch is visible in stills.
 * Layout marks below are the ones PhoneStage's default zoom and header patch point at.
 */
export const WA = {
  ink: '#000',
  grey: '#8A8A8E',
  blue: '#007AFF',
  bar: '#F6F6F6',
  hair: '#D5D5D8',
  wallpaper: '#EFE7DD',
  incoming: '#FFFFFF',
  outgoing: '#D9FDD3',
  tick: '#53BDEB',
  headerBottom: 300,
  footerTop: 2290,
};

const UI = '-apple-system, "SF Pro Text", "Host Grotesk", system-ui, sans-serif';

export const StatusBar: React.FC<{color?: string; time?: string}> = ({color = '#000', time = '9:41'}) => (
  <>
    <div
      style={{
        position: 'absolute', left: 0, width: 400, top: 56, height: 66, display: 'flex', alignItems: 'center', justifyContent: 'center',
        paddingLeft: 10, fontFamily: UI, fontSize: 52, fontWeight: 600, letterSpacing: '-.01em', color,
      }}
    >
      {time}
    </div>
    <div style={{position: 'absolute', right: 0, width: 400, top: 56, height: 66, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, paddingRight: 6}}>
      {/* cellular */}
      <svg width="54" height="36" viewBox="0 0 54 36">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 15} y={27 - i * 8} width="10" height={9 + i * 8} rx="3" fill={color} />
        ))}
      </svg>
      {/* wi-fi */}
      <svg width="50" height="36" viewBox="0 0 50 36">
        <path d="M25 34.5l-6.3-6.4a8.9 8.9 0 0112.6 0z" fill={color} />
        <path d="M13.2 22.6a16.7 16.7 0 0123.6 0l-3.4 3.4a11.9 11.9 0 00-16.8 0z" fill={color} />
        <path d="M7.4 16.8a24.9 24.9 0 0135.2 0l3.4-3.4a29.7 29.7 0 00-42 0z" fill={color} transform="translate(0 -6)" />
      </svg>
      {/* battery */}
      <svg width="82" height="38" viewBox="0 0 82 38">
        <rect x="1.5" y="1.5" width="71" height="35" rx="11" fill="none" stroke={color} strokeOpacity=".38" strokeWidth="3" />
        <rect x="6" y="6" width="54" height="26" rx="7" fill={color} />
        <path d="M76.5 13v12c3-1 5-3.4 5-6s-2-5-5-6z" fill={color} fillOpacity=".4" />
      </svg>
    </div>
  </>
);

// WhatsApp's bubble tail: a small hook that grows out of the bottom corner (fills the rounded corner too)
const Tail: React.FC<{out?: boolean}> = ({out}) => (
  <svg
    width="62"
    height="54"
    viewBox="0 0 62 54"
    style={{position: 'absolute', bottom: 0, [out ? 'right' : 'left']: -20, transform: out ? 'scaleX(-1)' : undefined}}
  >
    <path d="M20 0H62V54H4C2.2 54 1.6 52.4 2.8 51.2C10 46.5 17.5 40 20 26Z" fill={out ? WA.outgoing : WA.incoming} />
  </svg>
);

const Bubble: React.FC<{out?: boolean; time: string; tail?: boolean; children: React.ReactNode}> = ({out, time, tail, children}) => (
  <div
    style={{
      position: 'relative', alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: 860, margin: out ? '0 34px 0 0' : '0 0 0 34px',
      padding: '22px 30px 18px', borderRadius: 40, background: out ? WA.outgoing : WA.incoming,
      boxShadow: '0 2px 1px rgba(0,0,0,.08)', fontSize: 50, lineHeight: 1.3, color: WA.ink,
    }}
  >
    {tail ? <Tail out={out} /> : null}
    <span style={{position: 'relative'}}>{children}</span>
    <span style={{position: 'relative', float: 'right', margin: '22px -4px -6px 26px', fontSize: 33, color: WA.grey, display: 'inline-flex', alignItems: 'center', gap: 6}}>
      {time}
      {out ? (
        <svg width="46" height="28" viewBox="0 0 46 28">
          <path d="M3 15l7 7L25 5M18 20l3 3L39 5" fill="none" stroke={WA.tick} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  </div>
);

const DatePill: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div style={{alignSelf: 'center', fontSize: 34, fontWeight: 500, color: '#54656F', background: 'rgba(255,255,255,.92)', borderRadius: 22, padding: '10px 28px', margin: '30px 0 26px', boxShadow: '0 1px 1px rgba(0,0,0,.06)'}}>
    {children}
  </div>
);

const Icon: React.FC<{d: string; size?: number; stroke?: number; fill?: boolean}> = ({d, size = 66, stroke = 5, fill}) => (
  <svg width={size} height={size} viewBox="0 0 66 66">
    <path d={d} fill={fill ? WA.blue : 'none'} stroke={WA.blue} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const FakeWhatsApp: React.FC<{contact?: string; subtitle?: string}> = ({contact = '+1 (415) 523-8886', subtitle = 'tap here for contact info'}) => (
  <div style={{position: 'absolute', inset: 0, background: WA.wallpaper, fontFamily: UI, overflow: 'hidden'}}>
    {/* faint doodle-like texture, like WhatsApp's wallpaper */}
    <div
      style={{
        position: 'absolute', inset: 0, opacity: 0.5,
        background: 'radial-gradient(circle, rgba(120,100,80,.10) 3px, transparent 3.5px) 0 0/66px 66px, radial-gradient(circle, rgba(120,100,80,.06) 2px, transparent 2.5px) 33px 33px/66px 66px',
      }}
    />

    {/* header */}
    <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: WA.headerBottom, background: WA.bar, boxShadow: `0 1.5px 0 ${WA.hair}`}}>
      <StatusBar />
      <div style={{position: 'absolute', left: 26, top: 195, display: 'flex', alignItems: 'center', gap: 4, color: WA.blue, fontSize: 50}}>
        <Icon d="M40 12L19 33l21 21" stroke={6} />
        <span style={{marginLeft: -6}}>3</span>
      </div>
      <div style={{position: 'absolute', left: 150, top: 177, display: 'flex', alignItems: 'center', gap: 30}}>
        <div style={{width: 108, height: 108, borderRadius: '50%', background: '#C9CDD2', overflow: 'hidden', position: 'relative'}}>
          <div style={{position: 'absolute', left: 33, top: 20, width: 42, height: 42, borderRadius: '50%', background: '#fff'}} />
          <div style={{position: 'absolute', left: 14, top: 70, width: 80, height: 70, borderRadius: '50%', background: '#fff'}} />
        </div>
        <div style={{lineHeight: 1.2}}>
          <div style={{fontSize: 50, fontWeight: 600, color: WA.ink, letterSpacing: '-.01em'}}>{contact}</div>
          <div style={{fontSize: 35, color: WA.grey}}>{subtitle}</div>
        </div>
      </div>
      <div style={{position: 'absolute', right: 44, top: 198, display: 'flex', gap: 54}}>
        <Icon d="M8 20h32a4 4 0 014 4v18a4 4 0 01-4 4H8a4 4 0 01-4-4V24a4 4 0 014-4zm36 11l16-10v24L44 35z" stroke={4.5} />
        <Icon d="M20 8l7 13-5 5c3 7 8 12 15 15l5-5 13 7-2 9c-1 3-4 4-7 4C26 55 11 40 10 18c0-3 1-6 4-7z" stroke={4.5} />
      </div>
    </div>

    {/* messages */}
    <div style={{position: 'absolute', left: 0, right: 0, top: WA.headerBottom, bottom: 2556 - WA.footerTop + 34, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 16}}>
      <DatePill>Yesterday</DatePill>
      <Bubble out tail time="18:02">Hi</Bubble>
      <div style={{height: 20}} />
      <Bubble time="18:02" tail>
        Welcome to Otherwise. Here's your setup link, it takes about three minutes: <span style={{color: '#027EB5'}}>otherwise-homepage.vercel.app/s/k3f9</span>
      </Bubble>
      <DatePill>Today</DatePill>
      <Bubble time="9:38">Hi, I'm Otherwise. I had a look at your swipes.</Bubble>
      <Bubble time="9:38" tail>
        You like <b style={{fontWeight: 600}}>folk and indie</b> in small rooms, stand-up now and then, and not much techno. I'm already looking at this week.
      </Bubble>
      <div style={{height: 20}} />
      <Bubble out tail time="9:39">sounds good</Bubble>
      <div style={{height: 20}} />
      <Bubble time="9:40" tail>
        Found one: <b style={{fontWeight: 600}}>Kelsey Lu</b>, Thu 15 Oct, $39. Over your $25 limit, want it?
      </Bubble>
    </div>

    {/* composer */}
    <div style={{position: 'absolute', left: 0, right: 0, top: WA.footerTop, bottom: 0, background: WA.bar, boxShadow: `0 -1.5px 0 ${WA.hair}`}}>
      <div style={{position: 'absolute', left: 30, top: 34}}>
        <Icon d="M33 10v46M10 33h46" stroke={5} />
      </div>
      <div style={{position: 'absolute', left: 130, right: 250, top: 26, height: 84, borderRadius: 42, background: '#fff', boxShadow: `inset 0 0 0 2px ${WA.hair}`}} />
      <div style={{position: 'absolute', right: 140, top: 34}}>
        <Icon d="M8 22a5 5 0 015-5h8l4-6h16l4 6h8a5 5 0 015 5v26a5 5 0 01-5 5H13a5 5 0 01-5-5zM33 26a9 9 0 100 18 9 9 0 000-18z" stroke={4.5} />
      </div>
      <div style={{position: 'absolute', right: 40, top: 34}}>
        <Icon d="M33 8a8 8 0 018 8v16a8 8 0 01-16 0V16a8 8 0 018-8zM16 30a17 17 0 0034 0M33 47v10" stroke={4.5} />
      </div>
      {/* home indicator: 134 x 5 pt, 8 pt from the bottom */}
      <div style={{position: 'absolute', left: (1179 - 402) / 2, bottom: 24, width: 402, height: 15, borderRadius: 8, background: '#000'}} />
    </div>
  </div>
);
