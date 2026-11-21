/**
 * Everything the loading screen can say, in plain lists you can edit freely. One line per entry, short (under
 * 90 characters), no links, no "@", nothing about politics, religion, looks or real people. Tone: warm, witty,
 * a little sarcastic; half edtech (learners, upskilling, placements), half everyday work (spreadsheets,
 * follow-ups, meetings). Which list is used depends on the page (see pageKeyOf); EDTECH, WORK and THOUGHTS
 * are mixed into every page. Fresh lines written by the AI once a day are shown before these.
 */
export const PAGE_KEYS = [
  'dashboard', 'inbox', 'send', 'campaigns', 'templates', 'documents', 'automations', 'batches', 'data', 'contacts', 'suppressions',
  'deliverability', 'performance', 'reports', 'history', 'approvals', 'recruiter', 'mailbox', 'settings', 'admin', 'general',
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

/** The page name shown in the footer: "While you wait · Campaigns". */
export const PAGE_LABEL: Record<PageKey, string> = {
  dashboard: 'Dashboard', inbox: 'Inbox', send: 'Quick Send', campaigns: 'Campaigns', templates: 'Templates', documents: 'Documents',
  automations: 'Automations', batches: 'Batches', data: 'Data', contacts: 'Contacts', suppressions: 'Suppressions', deliverability: 'Deliverability',
  performance: 'Performance', reports: 'Reports', history: 'History', approvals: 'Approvals', recruiter: 'Recruiter Bulk Send', mailbox: 'Mailbox usage',
  settings: 'Settings', admin: 'Admin', general: 'MailFlow',
};

/** Which page's lines to use for an address. */
export function pageKeyOf(path: string): PageKey {
  const p = path.split('?')[0] ?? '';
  const is = (...prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
  if (is('/dashboard')) return 'dashboard';
  if (is('/inbox')) return 'inbox';
  if (is('/quick-send', '/quick-send-follow-up')) return 'send';
  if (is('/campaigns')) return 'campaigns';
  if (is('/templates')) return 'templates';
  if (is('/documents')) return 'documents';
  if (is('/automations')) return 'automations';
  if (is('/batches')) return 'batches';
  if (is('/data')) return 'data';
  if (is('/contacts')) return 'contacts';
  if (is('/suppressions')) return 'suppressions';
  if (is('/deliverability')) return 'deliverability';
  if (is('/performance')) return 'performance';
  if (is('/reports')) return 'reports';
  if (is('/history')) return 'history';
  if (is('/approvals')) return 'approvals';
  if (is('/recruiter-send', '/recruiter-follow-up')) return 'recruiter';
  if (is('/mailbox-usage')) return 'mailbox';
  if (is('/settings')) return 'settings';
  if (is('/admin')) return 'admin';
  return 'general';
}

export const PAGE_LINES: Record<PageKey, string[]> = {
  dashboard: [
    'Gathering today’s numbers…', 'Counting what went out, what came back, and what got ignored…', 'Lining up your day, politely…', 'Asking the data how the week is going…',
    'Warming up the charts…', 'Checking on the sends that were supposed to be quick…', 'Sorting wins from “we’ll circle back”…', 'Making the dashboard look effortless…',
  ],
  inbox: [
    'Opening your inbox…', 'Fetching replies (some of them are even nice)…', 'Sorting “thanks!” from “who is this?”…', 'Finding the emails that need you today…',
    'Reading the room, one thread at a time…', 'Checking who finally replied…', 'Untangling the reply-all chains…', 'Dusting off the threads from last week…',
  ],
  send: [
    'Warming up Quick Send…', 'Checking the list before it meets the world…', 'Making sure the subject line behaves…', 'Counting the recipients, then counting again…',
    'Lining up the mailboxes…', 'Proofreading, so you do not have to…', 'Checking who got your last email, so nobody gets two…', 'Getting the send button ready for its big moment…',
  ],
  campaigns: [
    'Opening your campaigns…', 'Counting opens, replies and polite silences…', 'Lining up what is scheduled and what is sent…', 'Checking which campaign is the star today…',
    'Finding the draft you swore you would finish…', 'Sorting campaigns by how brave they were…', 'Tallying the replies (the happy ones first)…', 'Reviewing the send queue…',
  ],
  templates: [
    'Opening the template shelf…', 'Fetching the emails you only have to write once…', 'Dusting off the best subject lines…', 'Checking that the {{variables}} still behave…',
    'Finding the template with the perfect “Hi”…', 'Sorting templates by how often they save the day…', 'Comparing versions, nicely…', 'Making copy-paste a thing of the past…',
  ],
  documents: [
    'Opening your documents…', 'Checking who signed and who is “about to”…', 'Sorting the PDFs, gently…', 'Finding the file that was “just here”…',
    'Counting signatures (the dotted line is working hard)…', 'Making paperwork feel lighter…', 'Lining up offer letters and good news…', 'Filing things where future-you can find them…',
  ],
  automations: [
    'Waking up your automations…', 'Checking what the robots did while you slept…', 'Teaching the rules to follow the rules…', 'Counting runs, retries and small miracles…',
    'Looking at your “if this, then that”…', 'Making sure nothing fires twice…', 'Letting the machines do the repetitive part…', 'Checking the flow, one step at a time…',
  ],
  batches: [
    'Opening your batches…', 'Counting what went out in each batch…', 'Checking the queue is moving (it is, slowly and carefully)…', 'Lining up the sends by time…',
    'Looking for the batch that is still thinking…', 'Pacing the sends so mailboxes stay happy…', 'Checking what is waiting for its turn…', 'Sorting the neat from the nervous…',
  ],
  data: [
    'Opening your data lists…', 'Counting rows (all of them, no skipping)…', 'Tidying columns that were never tidy…', 'Looking for duplicates that look suspiciously alike…',
    'Checking the sheet still matches the sheet…', 'Teaching the table to scroll fast…', 'Reading your headers, nicely…', 'Sorting data. The data is not cooperating…',
  ],
  contacts: [
    'Opening your contacts…', 'Looking up the people behind the emails…', 'Checking who you talked to last…', 'Sorting people, not just addresses…',
    'Finding out who has not heard from you in a while…', 'Matching names to threads…', 'Counting contacts. Politely…', 'Making sure nobody is in the list twice…',
  ],
  suppressions: [
    'Checking the do-not-email list…', 'Respecting every “please stop”…', 'Counting the addresses we are leaving alone…', 'Separating bounces from goodbyes…',
    'Keeping the sender reputation spotless…', 'Looking up who unsubscribed (we wish them well)…', 'Making sure we never email the wrong inbox twice…', 'Guarding the inbox of people who asked us to stay away…',
  ],
  deliverability: [
    'Checking how your emails are landing…', 'Reading the signals from the inbox providers…', 'Looking for the spam folder’s favourite words…', 'Measuring how welcome your emails are…',
    'Counting bounces and breathing calmly…', 'Making sure your mail arrives, not just leaves…', 'Checking the sender’s reputation (it has been working hard)…', 'Scoring the mailboxes…',
  ],
  performance: [
    'Measuring how the team is doing…', 'Counting replies per sender…', 'Finding out who sends the best subject lines…', 'Turning activity into something presentable…',
    'Comparing this week to last week, kindly…', 'Looking for the fastest replies…', 'Checking response times (yours included)…', 'Adding up a lot of small good work…',
  ],
  reports: [
    'Putting the report together…', 'Gathering the numbers the report is made of…', 'Making charts that make sense on Monday…', 'Counting opens, replies and quiet moments…',
    'Turning a busy week into a tidy page…', 'Checking the totals add up (they usually do)…', 'Drawing the lines between this week and last…', 'Getting the picture ready…',
  ],
  history: [
    'Opening the history…', 'Finding what happened, and when…', 'Rewinding the send log…', 'Looking up the one email you remember sending…',
    'Reading the log so you do not have to…', 'Sorting the past by what mattered…', 'Checking who sent what to whom…', 'Dusting off the archives…',
  ],
  approvals: [
    'Checking what is waiting for a yes…', 'Lining up the requests…', 'Counting the approvals that are very much “almost”…', 'Finding the campaigns that need your nod…',
    'Reading the notes people left for you…', 'Sorting by urgency (everything is urgent)…', 'Preparing the green buttons…', 'Checking who asked for what…',
  ],
  recruiter: [
    'Opening Recruiter Bulk Send…', 'Checking the recruiters you reached before…', 'Making sure nobody gets the same email twice…', 'Counting recruiters, then the ones we emailed lately…',
    'Lining up the mailboxes for the big send…', 'Looking at who replied since last time…', 'Checking the list for typos and surprises…', 'Pacing the send so Gmail stays calm…',
  ],
  mailbox: [
    'Checking how much each mailbox sent…', 'Counting messages against the daily limits…', 'Making sure no mailbox gets tired…', 'Looking at who still has room today…',
    'Measuring a day’s worth of sending…', 'Checking the mailboxes are connected and happy…', 'Balancing the load, kindly…', 'Adding up the sends…',
  ],
  settings: [
    'Opening your settings…', 'Checking the connections…', 'Making sure the keys are still under the mat…', 'Tuning the knobs…',
    'Looking at what is switched on…', 'Reading your preferences, carefully…', 'Checking the mailbox is still linked…', 'Dusting off the options…',
  ],
  admin: [
    'Preparing the control room…', 'Putting on the admin hat…', 'Checking who has access to what…', 'Reading the logs. Politely…',
    'Counting users, roles and requests…', 'Great power, loading responsibly…', 'Looking over the shoulder of the system (gently)…', 'Checking the switches that matter…',
  ],
  general: [
    'Warming up MailFlow…', 'Getting things ready…', 'Aligning the synergies…', 'Making sure everything is where you left it…',
    'Checking you are who you say you are…', 'Opening the door…', 'Getting your workspace ready…', 'One moment, setting the table…',
  ],
};

/** Edtech side, mixed into every page. */
export const EDTECH = [
  'Upskilling the pipeline, one learner at a time…', 'Turning course completions into offer letters…', 'Matching learners with roles they will actually enjoy…',
  'Syncing bootcamp graduates with hiring managers…', 'Placing learners, not just posting links…', 'Learning never stops. Neither does this spinner…',
  'Looking for companies that love a good project portfolio…', 'Finding mentors disguised as hiring managers…', 'Checking which employers read GitHub profiles…',
  'Making career switches a little less scary…', 'Practising mock interviews on the loading bar…', 'Turning “I am learning to code” into “I shipped it”…',
  'Reminding the cohort that the deadline is a suggestion with feelings…', 'Helping a fresher’s first email sound confident…',
];

/** Everyday work side, mixed into every page. */
export const WORK = [
  'Pretending to be busy while the data loads…', 'Opening 14 tabs so you do not have to…', 'Preparing a very important spreadsheet…', 'It works on my machine. Loading yours…',
  'Circling back on the circle-back…', 'Making Monday more bearable…', 'This loading bar is also a team player…', 'Reticulating splines…',
  'Sorting rows. The rows are not cooperating…', 'Turning caffeine into candidates…', 'Optimising the optimisation…', 'Scheduling a meeting to discuss this meeting…',
  'Following up on the follow-up…', 'Replying all, but only in spirit…',
];

/** Short one-sentence thoughts, shown in the footer. */
export const THOUGHTS = [
  'Good data beats a big database.', 'The best time to follow up was yesterday. The second best is now.', 'A 5% reply rate still means 5 people said yes.',
  'Hiring is a team sport. Spreadsheets are the referee.', 'Nobody ever regretted a clear subject line.', 'If it is not in the system, it did not happen.',
  'Be the sender you wish you had received.', 'Today’s “no” is next quarter’s “let’s talk”.', 'One personal email beats ten templates.', 'Measure twice, send once.',
  'Duplicates are just the same person trying their luck twice.', 'Stale leads are like bread: check before you serve.', 'Fast is fine. Accurate is better. Both is the goal.',
  'Every great placement starts with a boring spreadsheet.', 'Be kind to recruiters. They read 400 CVs today.', 'Progress, not perfection (but please fix the typos).',
  'A good follow-up is a nudge, not a siren.', 'Data cleaning: the unglamorous superpower.', 'Do not chase every lead. Chase the right ones.', 'Ctrl+F is a love language.',
  'Mondays are for pipelines. Fridays are for pretending to close them.', 'Consistency beats intensity, even in cold emails.', 'Say thank you. It is free and surprisingly rare.',
  'If everything is urgent, nothing is. Start with the replies.', 'Hope is not a strategy, but a follow-up date is.', 'The inbox is not a to-do list, but here we are.',
  'Coffee is not a data source, but it helps.', 'Meetings could have been emails. Emails could have been shortlists.', 'A learner with a project beats a learner with a certificate.',
  'Skills open the door. Manners keep it open.', 'Every offer letter started as a hello.', 'Curiosity is the best entry-level qualification.',
  'Teach the basics well and the placements follow.', 'A clean list today saves an awkward “who are you?” tomorrow.', 'The expert in anything was once a beginner who kept showing up.',
  'Read it out loud once. Your future self will thank you.', 'The unsubscribe button is a feature, not a failure.',
];
