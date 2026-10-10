import { createPrepared } from './prepared.js';

/**
 * Starter bank of typical interview questions with TEMPLATE answers.
 * Rules for the texts: only facts that are in Julian's CV (Full Stack / Development Lead, more than fourteen years building
 * software and leading teams, .NET, Azure, React, TypeScript, work with clients, GitHub Copilot); no employers, dates, figures or
 * invented achievements. Where a question asks for something personal that is not in the CV (a real weakness, a project, a salary),
 * the text gives an honest, generic structure that Julian replaces or personalizes with AI.
 * `triggers` are phrases that identify the question in what the interviewer says (matching is local, see prepared-matcher.js).
 */
const BANK = [
  {
    id: 'tell-me-about-yourself',
    question: 'Tell me about yourself',
    triggers: ['tell me about yourself', 'walk me through your background', 'walk me through your resume', 'introduce yourself', 'about yourself'],
    answer: {
      en: "I'm a Full Stack Lead with more than fourteen years of experience building software and leading teams. I work with .NET, Azure, React and TypeScript, and I enjoy working directly with clients. Now I'm looking for a role where I can lead and keep building.",
      es: 'Soy Full Stack Lead con más de catorce años de experiencia creando software y liderando equipos. Trabajo con .NET, Azure, React y TypeScript, y disfruto trabajar directamente con clientes. Ahora busco un rol donde pueda liderar y seguir construyendo.',
    },
    points: [
      { en: '14+ years building and leading', es: 'Más de 14 años construyendo y liderando' },
      { en: '.NET, Azure, React, TypeScript', es: '.NET, Azure, React, TypeScript' },
      { en: 'Client-facing work', es: 'Trabajo directo con clientes' },
    ],
  },
  {
    id: 'why-this-job',
    question: 'Why do you want this job?',
    triggers: ['why do you want this job', 'why do you want this role', 'why do you want this position', 'why do you want to work here', 'why do you want to join', 'why are you interested', 'why this role', 'why this company'],
    answer: {
      en: 'This role combines what I do best: leading a team and building solid products with .NET, Azure and React. I like to own results and work close to the business, and this position looks like a place where I can do both.',
      es: 'Este puesto combina lo que mejor hago: liderar un equipo y construir productos sólidos con .NET, Azure y React. Me gusta responsabilizarme de los resultados y trabajar cerca del negocio, y este puesto parece un lugar donde puedo hacer ambas cosas.',
    },
    points: [
      { en: 'Leading a team and building products', es: 'Liderar un equipo y construir productos' },
      { en: 'My stack matches: .NET, Azure, React', es: 'Mi stack encaja: .NET, Azure, React' },
      { en: 'I want to own results', es: 'Quiero responsabilizarme de los resultados' },
    ],
  },
  {
    id: 'leaving-current-job',
    question: 'Why are you leaving your current job?',
    triggers: ['why are you leaving', 'why do you want to leave', 'why did you leave', 'why are you looking', 'looking for a change'],
    answer: {
      en: "I'm not running away from anything. I'm looking for a bigger challenge where I can lead, grow my impact and keep learning. I'm grateful for what I've learned, and I want to apply it in a new environment.",
      es: 'No huyo de nada. Busco un reto mayor donde pueda liderar, aumentar mi impacto y seguir aprendiendo. Estoy agradecido por lo que he aprendido y quiero aplicarlo en un entorno nuevo.',
    },
    points: [
      { en: 'Looking for a bigger challenge', es: 'Busco un reto mayor' },
      { en: 'Positive about my current experience', es: 'Positivo sobre mi experiencia actual' },
      { en: 'Want to grow my impact', es: 'Quiero aumentar mi impacto' },
    ],
  },
  {
    id: 'strengths',
    question: 'What are your strengths?',
    triggers: ['your strengths', 'greatest strength', 'biggest strength'],
    answer: {
      en: "My main strengths are leading teams and turning client needs into clear technical solutions. I'm also comfortable across the stack, from .NET services on Azure to React interfaces, and I use AI tools like Copilot to move faster.",
      es: 'Mis principales fortalezas son liderar equipos y convertir las necesidades del cliente en soluciones técnicas claras. También me muevo con soltura en todo el stack, desde servicios .NET en Azure hasta interfaces React, y uso herramientas de IA como Copilot para avanzar más rápido.',
    },
    points: [
      { en: 'Leadership', es: 'Liderazgo' },
      { en: 'Full stack range', es: 'Dominio de todo el stack' },
      { en: 'Clear communication with clients', es: 'Comunicación clara con clientes' },
    ],
  },
  {
    id: 'biggest-weakness',
    question: 'What is your biggest weakness?',
    triggers: ['biggest weakness', 'greatest weakness', 'your weakness', 'your weaknesses', 'weaknesses'],
    answer: {
      en: "I used to take too much on myself instead of delegating. I've been working on it by trusting my team more, setting clear expectations and checking progress regularly instead of doing the work myself.",
      es: 'Solía asumir demasiado yo mismo en vez de delegar. He trabajado en ello confiando más en mi equipo, dejando claras las expectativas y revisando el avance con regularidad en lugar de hacer yo el trabajo.',
    },
    points: [
      { en: 'A real, honest weakness (replace it with yours)', es: 'Una debilidad real y honesta (sustitúyela por la tuya)' },
      { en: 'What I did about it', es: 'Qué hice al respecto' },
      { en: 'How I improved', es: 'Cómo he mejorado' },
    ],
  },
  {
    id: 'project-you-led',
    question: 'Tell me about a project you led',
    triggers: ['tell me about a project', 'project you led', 'project you are proud of', 'most challenging project'],
    answer: {
      en: "I'd pick a project where I led the team from planning to delivery. I explain the goal, my role in organizing the work, the technical decisions we made with .NET, Azure and React, and the result for the client.",
      es: 'Elegiría un proyecto en el que lideré al equipo desde la planificación hasta la entrega. Explico el objetivo, mi papel organizando el trabajo, las decisiones técnicas que tomamos con .NET, Azure y React, y el resultado para el cliente.',
    },
    points: [
      { en: 'Goal and context', es: 'Objetivo y contexto' },
      { en: 'My role as lead', es: 'Mi papel como líder' },
      { en: 'Result for the client', es: 'Resultado para el cliente' },
    ],
  },
  {
    id: 'how-you-lead',
    question: 'How do you lead a team?',
    triggers: ['lead a team', 'led a team', 'leadership style', 'how do you lead'],
    answer: {
      en: 'I lead by setting a clear direction and trusting the team. I keep expectations clear, remove blockers, give regular feedback and make sure everyone understands the why behind the work. I stay close enough to help, but not so close that I micromanage.',
      es: 'Lidero marcando una dirección clara y confiando en el equipo. Mantengo claras las expectativas, quito bloqueos, doy feedback con regularidad y me aseguro de que todos entiendan el porqué del trabajo. Estoy lo bastante cerca para ayudar, pero no tanto como para microgestionar.',
    },
    points: [
      { en: 'Clear direction and trust', es: 'Dirección clara y confianza' },
      { en: 'Remove blockers, give feedback', es: 'Quitar bloqueos y dar feedback' },
      { en: 'No micromanagement', es: 'Sin microgestión' },
    ],
  },
  {
    id: 'team-conflict',
    question: 'How do you handle conflict in a team?',
    triggers: ['conflict in your team', 'conflict with', 'handle conflict', 'deal with conflict', 'disagreement', 'difficult team member'],
    answer: {
      en: 'I address conflict early and directly. I listen to each side, focus on the goal rather than on people, and look for a solution everyone can support. If we still disagree, I make a clear decision and explain the reasons.',
      es: 'Abordo el conflicto pronto y de frente. Escucho a cada parte, me centro en el objetivo y no en las personas, y busco una solución que todos puedan apoyar. Si seguimos en desacuerdo, tomo una decisión clara y explico las razones.',
    },
    points: [
      { en: 'Act early and directly', es: 'Actuar pronto y de frente' },
      { en: 'Listen, focus on the goal', es: 'Escuchar y centrarse en el objetivo' },
      { en: 'Decide and explain why', es: 'Decidir y explicar el porqué' },
    ],
  },
  {
    id: 'tight-deadlines',
    question: 'How do you handle tight deadlines?',
    triggers: ['tight deadline', 'under pressure', 'handle pressure', 'deadlines'],
    answer: {
      en: 'I stay calm and focus on priorities. I agree with the client or stakeholders on what is essential, split the work into small deliverables, communicate risks early and protect the team from distractions.',
      es: 'Mantengo la calma y me centro en las prioridades. Acuerdo con el cliente o los interesados qué es esencial, divido el trabajo en entregables pequeños, comunico los riesgos pronto y protejo al equipo de distracciones.',
    },
    points: [
      { en: 'Agree on what is essential', es: 'Acordar qué es esencial' },
      { en: 'Small deliverables', es: 'Entregables pequeños' },
      { en: 'Communicate risks early', es: 'Comunicar riesgos pronto' },
    ],
  },
  {
    id: 'dotnet-experience',
    question: 'Describe your experience with .NET',
    triggers: ['experience with .net', 'experience in .net', '.net experience', 'work with .net', 'with .net', 'with c#', 'in c#', 'backend experience'],
    answer: {
      en: 'I have worked with .NET for many years, building APIs and backend services, and I combine it with Azure and React front ends. I care about clean architecture, testing and maintainable code, and I lead teams that deliver with it.',
      es: 'He trabajado con .NET durante muchos años, creando APIs y servicios de backend, y lo combino con Azure y front ends en React. Me importan la arquitectura limpia, las pruebas y el código mantenible, y lidero equipos que entregan con esta tecnología.',
    },
    points: [
      { en: 'APIs and backend services', es: 'APIs y servicios de backend' },
      { en: 'Works with Azure and React', es: 'Funciona con Azure y React' },
      { en: 'Clean architecture and testing', es: 'Arquitectura limpia y pruebas' },
    ],
  },
  {
    id: 'azure-cloud-experience',
    question: 'Describe your experience with Azure and the cloud',
    triggers: ['experience with azure', 'experience in azure', 'azure experience', 'work with azure', 'with azure', 'cloud experience', 'experience in the cloud'],
    answer: {
      en: 'I work with Azure to build and run applications, including hosting, deployment and monitoring. I like to keep cloud solutions simple, secure and cost-aware, and to automate deployments so teams can release with confidence.',
      es: 'Trabajo con Azure para construir y operar aplicaciones, incluyendo alojamiento, despliegue y monitorización. Me gusta mantener las soluciones en la nube simples, seguras y con control de costes, y automatizar los despliegues para que los equipos publiquen con confianza.',
    },
    points: [
      { en: 'Hosting, deployment, monitoring', es: 'Alojamiento, despliegue, monitorización' },
      { en: 'Simple, secure, cost-aware', es: 'Simple, seguro y con control de costes' },
      { en: 'Automated deployments', es: 'Despliegues automatizados' },
    ],
  },
  {
    id: 'scalable-architecture',
    question: 'How do you design a scalable architecture?',
    triggers: ['scalable architecture', 'scalable system', 'scalable', 'system design', 'design a system', 'how do you design'],
    answer: {
      en: 'I start from the requirements: users, load and constraints. Then I choose a simple design, separate responsibilities, plan for growth with caching and asynchronous work where it helps, and measure before optimizing. Clean boundaries make a system easier to scale and change.',
      es: 'Parto de los requisitos: usuarios, carga y restricciones. Luego elijo un diseño simple, separo responsabilidades, preparo el crecimiento con caché y trabajo asíncrono donde ayude, y mido antes de optimizar. Los límites claros hacen un sistema más fácil de escalar y cambiar.',
    },
    points: [
      { en: 'Requirements first: users, load, constraints', es: 'Primero los requisitos: usuarios, carga, restricciones' },
      { en: 'Simple design, clear boundaries', es: 'Diseño simple y límites claros' },
      { en: 'Measure before optimizing', es: 'Medir antes de optimizar' },
    ],
  },
  {
    id: 'code-quality',
    question: 'How do you ensure code quality?',
    triggers: ['code quality', 'unit test', 'testing strategy', 'code review', 'automated test'],
    answer: {
      en: 'I combine code reviews, automated tests and clear standards. I keep pull requests small, test the important behavior, and use continuous integration so problems show up early. I also encourage the team to share ownership of quality.',
      es: 'Combino revisiones de código, pruebas automáticas y estándares claros. Mantengo los pull requests pequeños, pruebo el comportamiento importante y uso integración continua para que los problemas aparezcan pronto. También animo al equipo a compartir la responsabilidad de la calidad.',
    },
    points: [
      { en: 'Code reviews and small pull requests', es: 'Revisiones de código y pull requests pequeños' },
      { en: 'Automated tests and CI', es: 'Pruebas automáticas e integración continua' },
      { en: 'Shared ownership of quality', es: 'Responsabilidad compartida de la calidad' },
    ],
  },
  {
    id: 'stay-up-to-date',
    question: 'How do you stay up to date with technology?',
    triggers: ['stay up to date', 'keep up with', 'learn new', 'staying current', 'stay current'],
    answer: {
      en: 'I follow official documentation, release notes and community articles, and I try new tools in small experiments before using them in real projects. I also learn from my team and from code reviews, and I use AI tools like Copilot to explore ideas faster.',
      es: 'Sigo la documentación oficial, las notas de versión y artículos de la comunidad, y pruebo herramientas nuevas en experimentos pequeños antes de usarlas en proyectos reales. También aprendo de mi equipo y de las revisiones de código, y uso herramientas de IA como Copilot para explorar ideas más rápido.',
    },
    points: [
      { en: 'Documentation and release notes', es: 'Documentación y notas de versión' },
      { en: 'Small experiments first', es: 'Primero experimentos pequeños' },
      { en: 'Learn from the team', es: 'Aprender del equipo' },
    ],
  },
  {
    id: 'ai-tools-copilot',
    question: 'How do you use AI tools like Copilot?',
    triggers: ['use copilot', 'with copilot', 'github copilot', 'ai tools', 'ai assistants', 'generative ai', 'artificial intelligence', 'ai in your'],
    answer: {
      en: "I use AI assistants like GitHub Copilot as a productivity tool: to draft code, explore options and write tests. I always review what they produce, because I'm responsible for the quality and security of the final result.",
      es: 'Uso asistentes de IA como GitHub Copilot como herramienta de productividad: para esbozar código, explorar opciones y escribir pruebas. Siempre reviso lo que producen, porque soy responsable de la calidad y la seguridad del resultado final.',
    },
    points: [
      { en: 'Draft code, explore options, write tests', es: 'Esbozar código, explorar opciones, escribir pruebas' },
      { en: 'Always review the output', es: 'Siempre revisar lo generado' },
      { en: 'I own quality and security', es: 'Soy responsable de calidad y seguridad' },
    ],
  },
  {
    id: 'mentoring',
    question: 'How do you mentor and grow your team?',
    triggers: ['mentor your team', 'mentoring experience', 'mentor', 'coach your team', 'grow your team', 'junior developer', 'develop your team'],
    answer: {
      en: 'I mentor by giving people real responsibility with support. I set growth goals together, give regular and honest feedback, pair on difficult problems and celebrate progress. My goal is that the team can solve problems without depending on me.',
      es: 'Hago mentoría dando responsabilidad real con apoyo. Fijamos juntos objetivos de crecimiento, doy feedback regular y honesto, trabajo en pareja en los problemas difíciles y celebro los avances. Mi meta es que el equipo resuelva problemas sin depender de mí.',
    },
    points: [
      { en: 'Real responsibility with support', es: 'Responsabilidad real con apoyo' },
      { en: 'Honest, regular feedback', es: 'Feedback honesto y regular' },
      { en: 'A team that does not depend on me', es: 'Un equipo que no depende de mí' },
    ],
  },
  {
    id: 'technical-debt',
    question: 'How do you manage technical debt?',
    triggers: ['technical debt', 'tech debt', 'legacy code', 'refactor'],
    answer: {
      en: 'I make technical debt visible and manage it like any other work. I agree with the business on what to fix first, refactor in small steps alongside new features, and protect changes with tests so we reduce risk instead of creating it.',
      es: 'Hago visible la deuda técnica y la gestiono como cualquier otro trabajo. Acuerdo con el negocio qué corregir primero, refactorizo en pasos pequeños junto a las funcionalidades nuevas y protejo los cambios con pruebas para reducir el riesgo en vez de crearlo.',
    },
    points: [
      { en: 'Make it visible', es: 'Hacerla visible' },
      { en: 'Prioritize with the business', es: 'Priorizar con el negocio' },
      { en: 'Small refactors protected by tests', es: 'Refactors pequeños protegidos por pruebas' },
    ],
  },
  {
    id: 'a-mistake',
    question: 'Tell me about a mistake and what you learned',
    triggers: ['a mistake', 'went wrong', 'learned from', 'a failure', 'biggest mistake'],
    answer: {
      en: 'I would choose a real mistake, explain what happened without blaming anyone, and focus on the fix and the lesson. Then I describe how I changed my process afterwards so the same problem would not happen again.',
      es: 'Elegiría un error real, explicaría lo que pasó sin culpar a nadie y me centraría en la solución y la lección. Después describo cómo cambié mi proceso para que el mismo problema no se repita.',
    },
    points: [
      { en: 'A real mistake (use your own story)', es: 'Un error real (usa tu propia historia)' },
      { en: 'Take responsibility, no blame', es: 'Asumir la responsabilidad, sin culpar' },
      { en: 'The fix and the lesson', es: 'La solución y la lección' },
    ],
  },
  {
    id: 'five-years',
    question: 'Where do you see yourself in five years?',
    triggers: ['five years', '5 years', 'where do you see yourself', 'career goals'],
    answer: {
      en: 'In five years I see myself leading larger, more impactful engineering work, helping teams grow and staying close to the technology. I want to keep learning, and I hope to do it in a company where I can build for the long term.',
      es: 'Dentro de cinco años me veo liderando trabajo de ingeniería más grande y con más impacto, ayudando a crecer a los equipos y manteniéndome cerca de la tecnología. Quiero seguir aprendiendo, y espero hacerlo en una empresa donde pueda construir a largo plazo.',
    },
    points: [
      { en: 'Larger, more impactful work', es: 'Trabajo más grande y con más impacto' },
      { en: 'Helping teams grow', es: 'Ayudar a crecer a los equipos' },
      { en: 'Long-term commitment', es: 'Compromiso a largo plazo' },
    ],
  },
  {
    id: 'salary-expectations',
    question: 'What are your salary expectations?',
    triggers: ['salary expectations', 'expected salary', 'your salary', 'salary are you', 'pay expectations', 'compensation expectations', 'compensation'],
    answer: {
      en: "I'd like to understand the full scope of the role and the total package first. I'm confident we can find a fair number that reflects the responsibility and my experience, and I'm open to discussing it once we both see the fit.",
      es: 'Primero me gustaría entender el alcance completo del puesto y el paquete total. Confío en que podremos encontrar una cifra justa que refleje la responsabilidad y mi experiencia, y estoy abierto a hablarlo cuando ambos veamos el encaje.',
    },
    points: [
      { en: 'Understand the full scope first', es: 'Primero entender el alcance completo' },
      { en: 'Fair number for the responsibility', es: 'Cifra justa para la responsabilidad' },
      { en: 'Open to discuss', es: 'Abierto a hablarlo' },
    ],
  },
  {
    id: 'questions-for-us',
    question: 'Do you have any questions for us?',
    triggers: ['questions for us', 'any questions', 'questions for me', 'questions about the'],
    answer: {
      en: 'Yes, thank you. What does success look like in this role in the first months? How is the team organized, and what are the biggest technical challenges right now? And what do you enjoy most about working here?',
      es: 'Sí, gracias. ¿Cómo es el éxito en este puesto en los primeros meses? ¿Cómo está organizado el equipo y cuáles son los mayores retos técnicos ahora mismo? ¿Y qué es lo que más disfrutas de trabajar aquí?',
    },
    points: [
      { en: 'What does success look like?', es: '¿Cómo es el éxito en el puesto?' },
      { en: 'Team structure and technical challenges', es: 'Estructura del equipo y retos técnicos' },
      { en: 'What they enjoy about working there', es: 'Qué disfrutan de trabajar allí' },
    ],
  },
  {
    id: 'why-hire-you',
    question: 'Why should we hire you?',
    triggers: ['why should we hire', 'hire you', 'what do you bring', 'what makes you different'],
    answer: {
      en: "You get someone who can lead a team and also build with .NET, Azure and React. I connect technical work with client needs, and I'm used to taking responsibility for results from planning to delivery.",
      es: 'Obtienen a alguien que puede liderar un equipo y también construir con .NET, Azure y React. Conecto el trabajo técnico con las necesidades del cliente y estoy acostumbrado a responsabilizarme de los resultados desde la planificación hasta la entrega.',
    },
    points: [
      { en: 'Lead and build', es: 'Liderar y construir' },
      { en: 'Technical work tied to client needs', es: 'Trabajo técnico ligado a las necesidades del cliente' },
      { en: 'Responsibility from planning to delivery', es: 'Responsabilidad de la planificación a la entrega' },
    ],
  },
  {
    id: 'what-motivates-you',
    question: 'What motivates you?',
    triggers: ['motivates you', 'what drives you', 'what motivates', 'motivated by'],
    answer: {
      en: "I'm motivated by building something useful and helping a team do its best work. I enjoy solving real problems for clients, learning continuously, and seeing a project move from an idea to a product people use.",
      es: 'Me motiva construir algo útil y ayudar a un equipo a dar lo mejor de sí. Disfruto resolviendo problemas reales de clientes, aprendiendo continuamente y viendo cómo un proyecto pasa de una idea a un producto que la gente usa.',
    },
    points: [
      { en: 'Building something useful', es: 'Construir algo útil' },
      { en: 'Helping a team do its best', es: 'Ayudar a un equipo a dar lo mejor' },
      { en: 'Continuous learning', es: 'Aprendizaje continuo' },
    ],
  },
  {
    id: 'next-role',
    question: 'What are you looking for in your next role?',
    triggers: ['next role', 'looking for in a', 'what are you looking for', 'looking for in your'],
    answer: {
      en: "I'm looking for a role with real responsibility, where I can lead a team and still stay close to the technology. I value clear goals, good engineering practices and an environment where people can grow.",
      es: 'Busco un puesto con responsabilidad real, donde pueda liderar un equipo y seguir cerca de la tecnología. Valoro los objetivos claros, las buenas prácticas de ingeniería y un entorno donde las personas puedan crecer.',
    },
    points: [
      { en: 'Real responsibility', es: 'Responsabilidad real' },
      { en: 'Lead and stay close to the technology', es: 'Liderar y seguir cerca de la tecnología' },
      { en: 'Good practices and room to grow', es: 'Buenas prácticas y espacio para crecer' },
    ],
  },
  {
    id: 'about-our-company',
    question: 'What do you know about our company?',
    triggers: ['about our company', 'know about us', 'know about the company', 'about the company'],
    answer: {
      en: 'Before this interview I looked into the company, its products and the role. I would be happy to share what stands out to me, and I would also like to hear from you what the team is focused on right now.',
      es: 'Antes de esta entrevista investigué la empresa, sus productos y el puesto. Con gusto comparto lo que más me llama la atención, y también me gustaría saber en qué está enfocado el equipo ahora mismo.',
    },
    points: [
      { en: 'Add one or two real facts about the company', es: 'Añade uno o dos datos reales de la empresa' },
      { en: 'Connect them to the role', es: 'Conéctalos con el puesto' },
      { en: 'Ask what the team is focused on', es: 'Pregunta en qué se enfoca el equipo' },
    ],
  },
  {
    id: 'greatest-achievement',
    question: 'What is your greatest achievement?',
    triggers: ['greatest achievement', 'biggest accomplishment', 'proudest achievement', 'most proud', 'greatest accomplishment'],
    answer: {
      en: "I'd highlight a project where I led the team and delivered a result that mattered to the client. I explain the challenge, what I personally did, and the impact, and I make sure to credit the team.",
      es: 'Destacaría un proyecto en el que lideré al equipo y entregué un resultado importante para el cliente. Explico el reto, lo que hice yo personalmente y el impacto, y me aseguro de dar crédito al equipo.',
    },
    points: [
      { en: 'The challenge', es: 'El reto' },
      { en: 'What I personally did', es: 'Lo que hice yo' },
      { en: 'The impact, and credit to the team', es: 'El impacto y el crédito al equipo' },
    ],
  },
  {
    id: 'feedback-and-criticism',
    question: 'How do you handle feedback and criticism?',
    triggers: ['handle feedback', 'handle criticism', 'receive feedback', 'take feedback', 'constructive criticism', 'feedback and criticism', 'take criticism'],
    answer: {
      en: 'I see feedback as a gift. I listen without defending myself, ask questions to understand, and turn it into concrete actions. I also give feedback regularly to my team, kindly and with examples, so there are no surprises.',
      es: 'Veo el feedback como un regalo. Escucho sin ponerme a la defensiva, hago preguntas para entender y lo convierto en acciones concretas. También doy feedback con regularidad a mi equipo, con amabilidad y con ejemplos, para que no haya sorpresas.',
    },
    points: [
      { en: 'Listen without defending', es: 'Escuchar sin defenderme' },
      { en: 'Turn it into actions', es: 'Convertirlo en acciones' },
      { en: 'Give feedback regularly too', es: 'Dar feedback con regularidad también' },
    ],
  },
  {
    id: 'prioritize-work',
    question: 'How do you prioritize your work?',
    triggers: ['how do you prioritize', 'prioritize your work', 'prioritise', 'too many tasks', 'competing priorities'],
    answer: {
      en: 'I prioritize by impact and urgency, aligned with the goals of the business or the client. I clarify what is essential, break work into small pieces, make trade-offs visible and re-check priorities regularly as things change.',
      es: 'Priorizo por impacto y urgencia, alineado con los objetivos del negocio o del cliente. Aclaro qué es esencial, divido el trabajo en piezas pequeñas, hago visibles los compromisos y reviso las prioridades con regularidad según cambian las cosas.',
    },
    points: [
      { en: 'Impact and urgency', es: 'Impacto y urgencia' },
      { en: 'Small pieces, visible trade-offs', es: 'Piezas pequeñas y compromisos visibles' },
      { en: 'Re-check priorities regularly', es: 'Revisar las prioridades con regularidad' },
    ],
  },
  {
    id: 'ideal-work-environment',
    question: 'Describe your ideal work environment',
    triggers: ['ideal work environment', 'ideal team', 'work culture', 'work style', 'ideal workplace'],
    answer: {
      en: 'I do best in a team with clear goals, open communication and trust. I like an environment where people take ownership, share knowledge and care about quality, and where there is room to learn and improve the way we work.',
      es: 'Rindo mejor en un equipo con objetivos claros, comunicación abierta y confianza. Me gusta un entorno donde las personas asumen responsabilidad, comparten conocimiento y cuidan la calidad, y donde hay espacio para aprender y mejorar la forma de trabajar.',
    },
    points: [
      { en: 'Clear goals, open communication, trust', es: 'Objetivos claros, comunicación abierta, confianza' },
      { en: 'Ownership and shared knowledge', es: 'Responsabilidad y conocimiento compartido' },
      { en: 'Room to learn and improve', es: 'Espacio para aprender y mejorar' },
    ],
  },
  {
    id: 'clients-and-stakeholders',
    question: 'How do you work with clients and stakeholders?',
    triggers: ['work with stakeholders', 'work with clients', 'client facing', 'communicate with clients', 'communicate with stakeholders', 'stakeholders'],
    answer: {
      en: "I work closely with clients and stakeholders: I listen first, translate their needs into clear technical goals, and keep them informed with simple updates. I'm honest about risks and trade-offs so there are no surprises.",
      es: 'Trabajo de cerca con clientes e interesados: primero escucho, traduzco sus necesidades en objetivos técnicos claros y los mantengo informados con actualizaciones sencillas. Soy honesto sobre riesgos y compromisos para que no haya sorpresas.',
    },
    points: [
      { en: 'Listen first', es: 'Primero escuchar' },
      { en: 'Translate needs into technical goals', es: 'Traducir necesidades en objetivos técnicos' },
      { en: 'Honest about risks, no surprises', es: 'Honesto con los riesgos, sin sorpresas' },
    ],
  },
  {
    id: 'disagree-with-manager',
    question: 'Tell me about a time you disagreed with your manager',
    triggers: ['disagreed with your manager', 'disagree with your manager', 'disagree with a manager', 'push back'],
    answer: {
      en: 'I would respectfully share my view with data and examples, listen to the reasons behind the decision, and look for common ground. If the decision stays, I commit to it and support it professionally.',
      es: 'Compartiría mi punto de vista con respeto, con datos y ejemplos, escucharía las razones de la decisión y buscaría puntos en común. Si la decisión se mantiene, me comprometo con ella y la apoyo de forma profesional.',
    },
    points: [
      { en: 'Share my view with data', es: 'Compartir mi punto de vista con datos' },
      { en: 'Listen to the reasons', es: 'Escuchar las razones' },
      { en: 'Commit to the final decision', es: 'Comprometerme con la decisión final' },
    ],
  },
];

export const DEFAULT_PREPARED = Object.freeze(BANK.map((entry) => Object.freeze(entry)));

/** The starter bank as storable items: every one has `status: 'template'` (unreviewed) and the given timestamp. */
export function seedPrepared(now) {
  return DEFAULT_PREPARED.map((entry) => createPrepared({
    id: entry.id, question: entry.question, triggers: entry.triggers, answer: entry.answer, points: entry.points, status: 'template', now,
  }));
}
