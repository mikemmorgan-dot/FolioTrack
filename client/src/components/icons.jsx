const S = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const IconOverview = (p) => (<svg {...S} className="nav-ico" {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>);
export const IconPerf = (p) => (<svg {...S} className="nav-ico" {...p}><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg>);
export const IconRisk = (p) => (<svg {...S} className="nav-ico" {...p}><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>);
export const IconHoldings = (p) => (<svg {...S} className="nav-ico" {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.3"/><circle cx="3.5" cy="12" r="1.3"/><circle cx="3.5" cy="18" r="1.3"/></svg>);
export const IconGeo = (p) => (<svg {...S} className="nav-ico" {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/></svg>);
export const IconMix = (p) => (<svg {...S} className="nav-ico" {...p}><path d="M12 3v9l7 4"/><circle cx="12" cy="12" r="9"/></svg>);
export const IconSort = (p) => (<svg {...S} width="18" height="18" {...p}><path d="M4 7h13"/><path d="M4 12h9"/><path d="M4 17h5"/><circle cx="19" cy="16" r="2.4"/></svg>);
export const IconMenu = (p) => (<svg {...S} {...p}><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>);
export const IconSearch = (p) => (<svg {...S} {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>);
export const IconFolder = (p) => (<svg {...S} width="72" height="72" viewBox="0 0 24 24" strokeWidth="1.3" {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>);
