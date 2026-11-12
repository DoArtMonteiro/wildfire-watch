import { LEGAL_ROUTES, SITE } from "@/lib/site";
import type { LegalContent } from "./types";

const contact = `[issues do repositório no GitHub](${SITE.contactUrl})`;

const pt: LegalContent = {
  chrome: {
    backToMap: "Voltar ao mapa",
    navLabel: "Informação legal",
    lastUpdated: "Última atualização",
    onThisPage: "Nesta página",
    linkLabels: {
      about: "Sobre",
      privacy: "Privacidade",
      terms: "Termos de utilização",
    },
  },
  documents: {
    about: {
      title: "Sobre o WildfireWatch",
      summary:
        "O WildfireWatch é um projeto pessoal, gratuito e não comercial, que mostra num mapa as anomalias térmicas detetadas por satélite. Não é uma fonte oficial de informação sobre incêndios.",
      sections: [
        {
          id: "aviso",
          title: "Aviso importante",
          blocks: [
            {
              type: "paragraph",
              text: "Em caso de emergência, ligue 112. Siga sempre as indicações das autoridades: a [Autoridade Nacional de Emergência e Proteção Civil (ANEPC)](https://prociv.gov.pt/), o [IPMA](https://www.ipma.pt/) e o [ICNF](https://www.icnf.pt/).",
            },
            {
              type: "list",
              items: [
                "Uma anomalia térmica não é necessariamente um incêndio florestal: queimas agrícolas, chaminés industriais, queima de gás e vulcões também são detetados.",
                "Um incêndio pode não aparecer: as nuvens, o fumo denso e o intervalo entre passagens do satélite impedem algumas deteções.",
                "Os dados chegam com atraso. A NASA publica as deteções em quase tempo real (normalmente até cerca de três horas após a passagem do satélite) e o WildfireWatch atualiza a sua cópia uma vez por hora.",
                "O WildfireWatch não sabe se um incêndio está ativo, dominado ou extinto. Os satélites medem calor; esse estado só é conhecido pelas autoridades.",
                "As áreas ardidas e o índice de qualidade do ar são estimativas, não medições oficiais. Os quadrados no mapa são os píxeis do sensor, não perímetros de incêndio.",
              ],
            },
          ],
        },
        {
          id: "metodologia",
          title: "Como os dados são tratados",
          blocks: [
            {
              type: "list",
              items: [
                "Origem: deteções do sensor VIIRS a bordo do satélite NOAA-20, distribuídas pelo serviço NASA FIRMS (produto VIIRS_NOAA20_NRT), das últimas 72 horas.",
                "Amostragem: o mapa mostra até 15 000 deteções. Todas as deteções em Portugal são mantidas; no resto do mundo, prevalecem as de maior potência radiativa e uma distribuição geográfica equilibrada. Os totais apresentados referem-se a esta amostra, não a todas as deteções mundiais.",
                "Potência radiativa (FRP): valor medido pelo satélite, em megawatts. O mapa agrupa-a em quatro classes de intensidade (abaixo de 10, 10 a 49, 50 a 149 e 150 MW ou mais), usadas apenas para as cores. Não é uma medida da gravidade do incêndio.",
                "Confiança: a categoria (baixa, nominal ou alta) que a NASA atribui a cada deteção.",
                "Área ardida: estimativa de ordem de grandeza, calculada a partir da potência radiativa e do tempo desde a primeira deteção. Pressupõe 0,368 kg de biomassa queimada por MJ de energia radiada (Wooster et al., 2005) e cerca de 3,8 kg/m² de combustível consumido, típico de matos e floresta. Não corresponde a uma área observada.",
                "Estado dos dados: o painel distingue a idade do instantâneo mostrado do estado da atualização automática. Se uma atualização falhar, continua a mostrar os últimos dados válidos e indica que a atualização está com falhas.",
                "Meteorologia: valores atuais do modelo Open-Meteo para as coordenadas do foco, não de uma estação no local.",
                "Qualidade do ar: leitura de PM2.5 da estação OpenAQ mais próxima, até 100 km, convertida num índice AQI estimado segundo os limiares da agência norte-americana EPA. A estação pode não refletir o fumo deste incêndio.",
                "Notícias: títulos e ligações dos últimos 30 dias, obtidos por pesquisa automática do nome do local no Google News e no Bing News. Podem referir-se a outros incêndios. O WildfireWatch não controla nem verifica o seu conteúdo.",
              ],
            },
          ],
        },
        {
          id: "responsavel",
          title: "Responsável e contacto",
          blocks: [
            {
              type: "paragraph",
              text: `O WildfireWatch é mantido por ${SITE.maintainer}, a título pessoal, como projeto de portfólio. Não há atividade comercial, publicidade nem recolha de pagamentos.`,
            },
            {
              type: "paragraph",
              text: `Para dúvidas, correções, pedidos sobre dados pessoais ou problemas de acessibilidade, utilize as ${contact}. O código-fonte está disponível no [repositório público](${SITE.repositoryUrl}).`,
            },
          ],
        },
        {
          id: "fontes",
          title: "Fontes de dados e atribuições",
          blocks: [
            {
              type: "list",
              items: [
                "Deteções de incêndio: reconhecemos a utilização de dados e imagens do Fire Information for Resource Management System (FIRMS) da NASA ([earthdata.nasa.gov/firms](https://www.earthdata.nasa.gov/firms)), parte do Earth Science Data and Information System (ESDIS) da NASA. A NASA não patrocina nem aprova este projeto.",
                "Mapa base: © [CARTO](https://carto.com/attributions) e © [contribuidores do OpenStreetMap](https://www.openstreetmap.org/copyright), dados disponíveis sob a licença ODbL.",
                "Imagem de satélite: Powered by Esri. Fontes: Esri, Maxar, Earthstar Geographics e a comunidade de utilizadores SIG.",
                "Nomes de locais: [Nominatim](https://nominatim.org/), com dados © contribuidores do OpenStreetMap.",
                "Meteorologia: [Open-Meteo.com](https://open-meteo.com/), sob a licença CC BY 4.0.",
                "Qualidade do ar: [OpenAQ](https://openaq.org/) e as entidades que publicam cada estação.",
                "Notícias: Google News e Bing News. Os títulos e os artigos pertencem aos respetivos editores.",
                "Tipos de letra: Geist e JetBrains Mono, sob a licença SIL Open Font License 1.1.",
              ],
            },
          ],
        },
        {
          id: "acessibilidade",
          title: "Acessibilidade",
          blocks: [
            {
              type: "paragraph",
              text: "O objetivo é cumprir o nível AA das Diretrizes de Acessibilidade para Conteúdo Web (WCAG) 2.2. Contraste, foco visível do teclado, nomes acessíveis dos controlos e preferência por movimento reduzido foram revistos.",
            },
            {
              type: "list",
              items: [
                "O mapa é um elemento gráfico. Com o foco no mapa, as setas deslocam a vista e as teclas + e − alteram o zoom.",
                "Para quem não usa o rato, o painel lateral apresenta uma lista das deteções mais intensas. Cada entrada abre o detalhe do foco, sem passar pelo mapa.",
                "No início da página, um atalho permite saltar diretamente para o painel de informação.",
              ],
            },
            {
              type: "paragraph",
              text: `Se encontrar uma barreira de acessibilidade, comunique-a nas ${contact}.`,
            },
          ],
        },
      ],
    },
    privacy: {
      title: "Política de privacidade e cookies",
      summary:
        "O WildfireWatch não tem contas, formulários, cookies, ferramentas de análise de tráfego nem publicidade. Esta página explica os poucos dados técnicos envolvidos na utilização do site.",
      sections: [
        {
          id: "responsavel",
          title: "Responsável pelo tratamento",
          blocks: [
            {
              type: "paragraph",
              text: `O responsável é ${SITE.maintainer}, que mantém o WildfireWatch a título pessoal. Contacto: ${contact}.`,
            },
          ],
        },
        {
          id: "dados",
          title: "Que dados são tratados",
          blocks: [
            {
              type: "list",
              items: [
                "Dados técnicos de cada pedido (endereço IP, navegador, página pedida, data e hora), tratados pela Cloudflare, que aloja o site, para o entregar e proteger contra abusos.",
                "Registos de funcionamento do servidor (Cloudflare Workers Logs) com o endereço pedido e mensagens de erro, mantidos até 7 dias para detetar avarias. Não são usados para identificar visitantes.",
                "Preferências de idioma e de tema, guardadas apenas no seu dispositivo (ver «Cookies e armazenamento local»).",
              ],
            },
            {
              type: "paragraph",
              text: "O WildfireWatch não pede a sua localização, não cria perfis, não usa dados para publicidade e não vende nem partilha dados com terceiros para fins comerciais.",
            },
          ],
        },
        {
          id: "terceiros",
          title: "Serviços de terceiros",
          blocks: [
            {
              type: "paragraph",
              text: "Para desenhar o mapa e mostrar a meteorologia, o seu navegador contacta diretamente os serviços abaixo. Como em qualquer pedido na Internet, estes recebem o seu endereço IP e a identificação do navegador, e tratam-nos segundo as respetivas políticas de privacidade.",
            },
            {
              type: "table",
              caption: "Serviços contactados diretamente pelo navegador",
              head: ["Serviço", "Finalidade", "Dados enviados além do IP"],
              rows: [
                ["[CARTO](https://carto.com/privacy)", "Mapa base e rótulos", "Zona do mapa visualizada"],
                ["[Esri](https://www.esri.com/en-us/privacy/overview)", "Imagem de satélite", "Zona do mapa visualizada"],
                ["[Open-Meteo](https://open-meteo.com/en/terms)", "Meteorologia do foco selecionado", "Coordenadas do foco (não as suas)"],
              ],
            },
            {
              type: "paragraph",
              text: "Os restantes serviços (NASA FIRMS, OpenAQ, Nominatim, Google News e Bing News) são contactados pelo servidor do WildfireWatch e recebem apenas coordenadas ou nomes de locais dos focos, nunca dados sobre si. Ao abrir uma notícia, passa a navegar no site do respetivo editor, que tem as suas próprias regras.",
            },
            {
              type: "paragraph",
              text: "Se a atualização automática dos dados falhar repetidamente, o servidor pode avisar o responsável por Discord ou Telegram. Esses avisos contêm apenas o estado técnico da atualização (hora, código de erro, idade dos dados e número de deteções), nunca dados de visitantes.",
            },
          ],
        },
        {
          id: "fundamento",
          title: "Fundamento e transferências",
          blocks: [
            {
              type: "paragraph",
              text: "Os dados técnicos são tratados com base no interesse legítimo em disponibilizar e proteger o site (artigo 6.º, n.º 1, alínea f), do Regulamento Geral sobre a Proteção de Dados). Alguns fornecedores podem tratar dados fora do Espaço Económico Europeu, ao abrigo dos mecanismos de transferência previstos no RGPD.",
            },
          ],
        },
        {
          id: "cookies",
          title: "Cookies e armazenamento local",
          blocks: [
            {
              type: "paragraph",
              text: "O WildfireWatch não define cookies. Guarda apenas duas preferências no armazenamento local do navegador (localStorage), quando as escolhe. Nunca saem do seu dispositivo.",
            },
            {
              type: "table",
              caption: "Itens guardados no armazenamento local",
              head: ["Nome", "Finalidade", "Duração"],
              rows: [
                ["wildfirewatch-locale", "Idioma escolhido (português ou inglês)", "Até limpar os dados do site"],
                ["theme", "Tema escolhido (claro ou escuro)", "Até limpar os dados do site"],
              ],
            },
            {
              type: "paragraph",
              text: "Como servem apenas para prestar um serviço que pediu expressamente, estes itens não exigem consentimento prévio, nos termos do artigo 5.º da Lei n.º 41/2004 (na redação atual). Por isso, o site não mostra um aviso de cookies. Pode apagá-los a qualquer momento nas definições do navegador.",
            },
          ],
        },
        {
          id: "direitos",
          title: "Os seus direitos",
          blocks: [
            {
              type: "paragraph",
              text: `Tem direito de acesso, retificação, apagamento, limitação e oposição ao tratamento (artigos 15.º a 21.º do RGPD). Como o WildfireWatch não guarda dados que o identifiquem, normalmente não é possível associar um pedido a uma pessoa. Para exercer estes direitos, utilize as ${contact}. Pode ainda apresentar reclamação à [Comissão Nacional de Proteção de Dados (CNPD)](https://www.cnpd.pt/).`,
            },
          ],
        },
        {
          id: "alteracoes",
          title: "Alterações",
          blocks: [
            {
              type: "paragraph",
              text: "Esta política é atualizada sempre que o site passe a tratar dados de outra forma, por exemplo se vier a ter publicidade ou estatísticas de visitas. Nesse caso, qualquer cookie não essencial só será usado com o seu consentimento prévio.",
            },
          ],
        },
      ],
    },
    terms: {
      title: "Termos de utilização",
      summary:
        "Ao utilizar o WildfireWatch aceita estes termos. O serviço é gratuito, informativo e não oficial.",
      sections: [
        {
          id: "natureza",
          title: "Natureza da informação",
          blocks: [
            {
              type: "paragraph",
              text: `O WildfireWatch apresenta dados públicos de terceiros e estimativas próprias, sem garantia de exatidão, de completude ou de atualidade. Não substitui a informação das autoridades nem deve ser usado para decisões de segurança, evacuação ou combate a incêndios. Em caso de emergência, ligue 112. Veja os limites dos dados na página [Sobre](${LEGAL_ROUTES.about}#aviso).`,
            },
          ],
        },
        {
          id: "utilizacao",
          title: "Utilização aceitável",
          blocks: [
            {
              type: "list",
              items: [
                "Não sobrecarregue o site nem os seus endereços /api/ com pedidos automáticos em massa.",
                "Não use o site para contornar os limites ou as condições das fontes de dados originais.",
                "Respeite as licenças e as atribuições de terceiros indicadas na página Sobre.",
              ],
            },
          ],
        },
        {
          id: "propriedade",
          title: "Propriedade intelectual",
          blocks: [
            {
              type: "paragraph",
              text: `O código e o design do WildfireWatch pertencem ao seu autor. Os dados, as imagens de satélite, os mapas e as notícias pertencem às respetivas fontes, identificadas na página [Sobre](${LEGAL_ROUTES.about}#fontes), e estão sujeitos às suas licenças.`,
            },
          ],
        },
        {
          id: "ligacoes",
          title: "Ligações externas",
          blocks: [
            {
              type: "paragraph",
              text: "As notícias e outras ligações levam a sites de terceiros. O WildfireWatch não controla esses conteúdos nem responde por eles.",
            },
          ],
        },
        {
          id: "responsabilidade",
          title: "Responsabilidade e disponibilidade",
          blocks: [
            {
              type: "paragraph",
              text: "O serviço é fornecido tal como está e pode ser alterado, interrompido ou terminado sem aviso. Na medida permitida pela lei, o autor não responde por danos resultantes da utilização da informação. Nada nestes termos exclui responsabilidade que a lei não permita excluir, nem afasta os direitos que a lei reconhece aos consumidores.",
            },
          ],
        },
        {
          id: "lei",
          title: "Lei aplicável e contacto",
          blocks: [
            {
              type: "paragraph",
              text: `Estes termos regem-se pela lei portuguesa. Para qualquer questão, utilize as ${contact}. A forma como os dados são tratados consta da [Política de privacidade](${LEGAL_ROUTES.privacy}).`,
            },
          ],
        },
      ],
    },
  },
};

export default pt;
